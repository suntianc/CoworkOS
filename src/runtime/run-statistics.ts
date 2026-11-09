import { createHash } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "../domain/types.js";
import { agentDisplayName } from "./agent-identity.js";

export interface TokenUsage {
  /** Pi input excludes cached input; output already includes reasoning. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadReportedResponses: number;
  cacheWriteReportedResponses: number;
  cacheReadCoverage: "complete" | "partial" | "unavailable";
  cacheWriteCoverage: "complete" | "partial" | "unavailable";
  totalTokens: number | null;
  responses: number;
  reportedResponses: number;
  coverage: "complete" | "partial" | "unavailable";
  scanning: boolean;
}

type Report = Pick<TokenUsage, "input" | "output" | "cacheRead" | "cacheWrite"> & {
  tokenUsageReported: boolean;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
};
interface UsageAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  responses: number;
  reportedResponses: number;
  cacheReadReportedResponses: number;
  cacheWriteReportedResponses: number;
  incomplete: boolean;
  reports: Map<string, Report | null>;
  latestAt?: number;
}

const emptyUsage = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  responses: 0,
  reportedResponses: 0,
  cacheReadReportedResponses: 0,
  cacheWriteReportedResponses: 0,
  incomplete: false,
  reports: new Map()
});
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function addReport(summary: UsageAccumulator, key: string, report: Report | null): void {
  if (summary.reports.get(key)) return;
  if (!summary.reports.has(key)) summary.responses += 1;
  summary.reports.set(key, report);
  if (!report) return;
  if (report.tokenUsageReported) summary.reportedResponses += 1;
  if (report.cacheReadReported) summary.cacheReadReportedResponses += 1;
  if (report.cacheWriteReported) summary.cacheWriteReportedResponses += 1;
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
    summary[field] += report[field];
}

function mergeUsage(summary: UsageAccumulator, source: UsageAccumulator, namespace = ""): void {
  for (const [key, report] of source.reports) addReport(summary, `${namespace}:${key}`, report);
  summary.incomplete ||= source.incomplete;
}

interface UsageRecord {
  type?: string;
  payload?: UsageRecord;
  occurredAt?: string;
  eventId?: string;
  message?: {
    role?: string;
    timestamp?: number;
    responseId?: string;
    model?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      tokenUsageReported?: boolean;
      cacheReadReported?: boolean;
      cacheWriteReported?: boolean;
    };
  };
}
function consumeUsage(summary: UsageAccumulator, record: UsageRecord): void {
  const event = record.payload ?? record;
  const message = event.message;
  const time = milliseconds(record.occurredAt) ?? (count(message?.timestamp) ? message.timestamp : undefined);
  if (time !== undefined) summary.latestAt = Math.max(summary.latestAt ?? time, time);
  // turn_end and agent_end repeat these same messages. Streaming snapshots
  // also contain cumulative usage, so only finalized responses are counted.
  if (event.type !== "message_end" || message?.role !== "assistant") return;
  const key =
    message.responseId || message.timestamp
      ? JSON.stringify([message.responseId, message.timestamp, message.model])
      : record.eventId || createHash("sha256").update(JSON.stringify(message)).digest("hex");
  const usage = message.usage;
  const report =
    usage && [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].every(count)
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          tokenUsageReported:
            usage.tokenUsageReported === true ||
            (usage.tokenUsageReported === undefined &&
              [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].some(
                (value) => value > 0
              )),
          // Legacy zeros are ambiguous. Positive counters are still useful evidence.
          cacheReadReported:
            usage.cacheReadReported === true ||
            (usage.cacheReadReported === undefined && (usage.cacheRead ?? 0) > 0),
          cacheWriteReported:
            usage.cacheWriteReported === true ||
            (usage.cacheWriteReported === undefined && (usage.cacheWrite ?? 0) > 0)
        }
      : null;
  // Pi initializes absent provider usage to zero, including aborted requests.
  // A missing report must not look like a free model response.
  addReport(
    summary,
    key,
    report &&
      ([report.input, report.output, report.cacheRead, report.cacheWrite].some((value) => value > 0) ||
        report.tokenUsageReported ||
        report.cacheReadReported ||
        report.cacheWriteReported)
      ? report
      : null
  );
}

function snapshot(summary: UsageAccumulator, scanning = false): TokenUsage {
  const cacheCoverage = (reported: number): TokenUsage["coverage"] =>
    !reported
      ? "unavailable"
      : summary.incomplete || scanning || reported < summary.responses
        ? "partial"
        : "complete";
  return {
    cacheReadReportedResponses: summary.cacheReadReportedResponses,
    cacheWriteReportedResponses: summary.cacheWriteReportedResponses,
    cacheReadCoverage: cacheCoverage(summary.cacheReadReportedResponses),
    cacheWriteCoverage: cacheCoverage(summary.cacheWriteReportedResponses),
    input: summary.input,
    output: summary.output,
    cacheRead: summary.cacheRead,
    cacheWrite: summary.cacheWrite,
    totalTokens: summary.reportedResponses
      ? summary.input + summary.output + summary.cacheRead + summary.cacheWrite
      : null,
    responses: summary.responses,
    reportedResponses: summary.reportedResponses,
    coverage: !summary.reportedResponses
      ? "unavailable"
      : summary.incomplete || scanning || summary.reportedResponses < summary.responses
        ? "partial"
        : "complete",
    scanning
  };
}

interface UsageCursor {
  offset: number;
  ino?: number;
  mtimeMs?: number;
  pending: Buffer;
  skipLine: boolean;
  summary: UsageAccumulator;
  scanning: boolean;
  busy?: Promise<void>;
}
const usageCursors = new Map<string, UsageCursor>();
const READ_BUDGET = 16 * 1024 * 1024;
const LINE_BUDGET = 4 * 1024 * 1024;

/** Scan each trace once, then only appended bytes. Large legacy traces catch
 * up across polls instead of returning an unlabelled sample or blocking UI. */
async function readUsage(path: string): Promise<{ summary: UsageAccumulator; scanning: boolean }> {
  let cursor = usageCursors.get(path);
  if (!cursor) {
    cursor = { offset: 0, pending: Buffer.alloc(0), skipLine: false, summary: emptyUsage(), scanning: false };
    usageCursors.set(path, cursor);
    if (usageCursors.size > 128) {
      const oldest = [...usageCursors].find(([key, value]) => key !== path && !value.busy);
      if (oldest) usageCursors.delete(oldest[0]);
    }
  }
  const current = cursor;
  try {
    current.busy ??= updateUsage(path, current).finally(() => {
      current.busy = undefined;
    });
    await current.busy;
    return { summary: current.summary, scanning: current.scanning };
    // eslint-disable-next-line no-restricted-syntax -- trace 可能被轮转或删除，读取失败用 incomplete 标记该 Run 的用量不完整，其它统计继续
  } catch {
    return { summary: { ...current.summary, incomplete: true }, scanning: current.scanning };
  }
}

async function updateUsage(path: string, cursor: UsageCursor): Promise<void> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (
      cursor.ino !== info.ino ||
      info.size < cursor.offset ||
      (info.size === cursor.offset && cursor.mtimeMs !== info.mtimeMs)
    ) {
      cursor.offset = 0;
      cursor.pending = Buffer.alloc(0);
      cursor.skipLine = false;
      cursor.summary = emptyUsage();
    }
    cursor.ino = info.ino;
    cursor.mtimeMs = info.mtimeMs;
    const end = Math.min(info.size, cursor.offset + READ_BUDGET);
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (cursor.offset < end) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, end - cursor.offset),
        cursor.offset
      );
      if (!bytesRead) break;
      cursor.offset += bytesRead;
      const data = Buffer.concat([cursor.pending, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
        if (cursor.skipLine) cursor.skipLine = false;
        else if (newline - start > LINE_BUDGET) cursor.summary.incomplete = true;
        else {
          const line = data.subarray(start, newline).toString("utf8");
          try {
            consumeUsage(cursor.summary, JSON.parse(line));
            // eslint-disable-next-line no-restricted-syntax -- trace 行可能因进程退出被截断，跳过该行；含 message_end 的行缺失时已标记 incomplete
          } catch {
            if (/message_end/.test(line)) cursor.summary.incomplete = true;
          }
        }
        start = newline + 1;
      }
      if (data.length - start > LINE_BUDGET || cursor.skipLine) {
        cursor.pending = Buffer.alloc(0);
        cursor.skipLine = true;
        cursor.summary.incomplete = true;
      } else cursor.pending = Buffer.from(data.subarray(start));
    }
    cursor.scanning = cursor.offset < info.size;
  } finally {
    await file.close();
  }
}

type TimedEvent = { type?: string; occurredAt?: string };
const milliseconds = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Sum Main process intervals, including tools/delegation waits but excluding
 * idle gaps before a resumed invocation. Inactive legacy runs freeze too. */
export function runTiming(input: {
  task: Pick<TaskRecord, "createdAt" | "updatedAt" | "completedAt">;
  createdAt?: string;
  events: TimedEvent[];
  active: boolean;
  nowMs: number;
}) {
  let started = milliseconds(input.createdAt);
  let interval: number | undefined;
  let ended: number | undefined;
  let elapsed = 0;
  let spawned = false;
  for (const event of input.events) {
    const time = milliseconds(event.occurredAt);
    if (time === undefined) continue;
    if (event.type === "main.run_spawned") {
      started ??= time;
      interval ??= time;
      spawned = true;
      ended = undefined;
    } else if (
      ["main.run_completed", "main.run_failed", "main.run_waiting", "main.run_stopped"].includes(
        event.type ?? ""
      )
    ) {
      const from = interval ?? (!spawned && ended === undefined ? started : undefined);
      if (from !== undefined) elapsed += Math.max(0, time - from);
      interval = undefined;
      ended = time;
    }
  }
  // Never use Task creation as the start of a later follow-up run.
  if (started === undefined) return { startedAt: null, endedAt: null, elapsedMs: null, active: false };
  if (!spawned && ended === undefined) interval = started;
  const active = input.active && interval !== undefined;
  if (interval !== undefined) {
    const stop = active
      ? input.nowMs
      : (milliseconds(input.task.completedAt) ?? milliseconds(input.task.updatedAt) ?? interval);
    elapsed += Math.max(0, stop - interval);
    if (!active) ended = Math.max(interval, stop);
  }
  return {
    startedAt: new Date(started).toISOString(),
    endedAt: ended === undefined ? null : new Date(ended).toISOString(),
    elapsedMs: elapsed,
    active
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
    // eslint-disable-next-line no-restricted-syntax -- Run 元数据可能尚未写入或已损坏，缺失用调用方给的默认值表达
  } catch {
    return fallback;
  }
}

export async function readRunStatistics(input: {
  workspaceRoot: string;
  task: TaskRecord;
  active: boolean;
  nowMs?: number;
}) {
  const runId = input.task.activeRunId;
  const taskRoot = join(input.workspaceRoot, input.task.taskId);
  // eslint-disable-next-line no-restricted-syntax -- runs 目录可能还不存在（Task 尚未创建 Run），没有目录按空列表处理
  const entries = await readdir(join(taskRoot, "runs"), { withFileTypes: true }).catch(() => []);
  const runIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  if (runId) runIds.add(runId);
  if (!runIds.size) return null;
  const nowMs = input.nowMs ?? Date.now();
  const runs = await Promise.all(
    [...runIds].map(async (id) => {
      const runRoot = join(taskRoot, "runs", id);
      const [metadata, queue, eventLog] = await Promise.all([
        readJson<{ createdAt?: string; updatedAt?: string }>(join(runRoot, "run.json"), {}),
        readJson<Array<{ stepId: string; agentId: string }>>(join(runRoot, "queue.json"), []),
        // eslint-disable-next-line no-restricted-syntax -- 该 Run 可能还没有 run_events.jsonl，读不到按空日志处理，其余 Run 照常统计
        readFile(join(runRoot, "run_events.jsonl"), "utf8").catch(() => "")
      ]);
      const events: TimedEvent[] = eventLog.split(/\r?\n/).flatMap((line) => {
        try {
          return [JSON.parse(line)];
          // eslint-disable-next-line no-restricted-syntax -- run_events.jsonl 的行可能被截断或来自其它版本，跳过该行，其它事件仍参与时间线计算
        } catch {
          return [];
        }
      });
      const members = new Map(
        queue.filter((item) => item.agentId !== "main").map((item) => [item.agentId, item])
      );
      const agents = await Promise.all(
        [
          { agentId: "main", callId: undefined, path: join(runRoot, "runtime-output.log") },
          ...[...members.values()].map((item) => ({
            agentId: item.agentId,
            callId: item.stepId,
            path: join(taskRoot, "sessions", item.agentId, `${id}.jsonl`)
          }))
        ].map(async (member) => ({
          agentId: member.agentId,
          callId: member.callId,
          ...(await readUsage(member.path))
        }))
      );
      // A historical run cannot use today's Task timestamp as its missing exit
      // time: every follow-up would otherwise extend its duration indefinitely.
      const evidence = [metadata.createdAt, metadata.updatedAt, ...events.map((event) => event.occurredAt)]
        .map(milliseconds)
        .concat(agents.map((agent) => agent.summary.latestAt))
        .filter((value): value is number => value !== undefined);
      const lastKnown = evidence.length ? new Date(Math.max(...evidence)).toISOString() : undefined;
      const task =
        id === runId
          ? input.task
          : { ...input.task, completedAt: lastKnown, updatedAt: lastKnown ?? input.task.createdAt };
      return {
        id,
        agents,
        timing: runTiming({
          task,
          createdAt: metadata.createdAt,
          events,
          active: id === runId && input.active,
          nowMs
        })
      };
    })
  );
  runs.sort(
    (a, b) => (a.timing.startedAt ?? "").localeCompare(b.timing.startedAt ?? "") || a.id.localeCompare(b.id)
  );
  const byAgent = new Map<
    string,
    { agentId: string; callId?: string; current: boolean; summary: UsageAccumulator; scanning: boolean }
  >();
  for (const run of runs)
    for (const agent of run.agents) {
      const combined = byAgent.get(agent.agentId) ?? {
        agentId: agent.agentId,
        current: false,
        summary: emptyUsage(),
        scanning: false
      };
      mergeUsage(combined.summary, agent.summary);
      combined.scanning ||= agent.scanning;
      if (run.id === runId) {
        combined.current = true;
        combined.callId = agent.callId;
      }
      byAgent.set(agent.agentId, combined);
    }
  const combined = emptyUsage();
  const agents = [...byAgent.values()]
    .map(({ summary, scanning, ...agent }) => {
      mergeUsage(combined, summary, agent.agentId);
      return {
        ...agent,
        name: agent.agentId === "main" ? "CoworkOS" : agentDisplayName(agent.agentId),
        usage: snapshot(summary, scanning)
      };
    })
    .sort((a, b) =>
      a.agentId === "main"
        ? -1
        : b.agentId === "main"
          ? 1
          : a.agentId.localeCompare(b.agentId, "en", { numeric: true })
    );
  const timed = runs.map((run) => run.timing).filter((timing) => timing.elapsedMs !== null);
  const active = timed.some((timing) => timing.active);
  return {
    scope: "conversation",
    taskId: input.task.taskId,
    runId,
    runCount: runs.length,
    startedAt: timed[0]?.startedAt ?? null,
    endedAt: active
      ? null
      : (timed
          .map((timing) => timing.endedAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null),
    elapsedMs: timed.length ? timed.reduce((sum, timing) => sum + timing.elapsedMs, 0) : null,
    timingPartial: timed.length < runs.length,
    active,
    observedAt: new Date(nowMs).toISOString(),
    usage: snapshot(
      combined,
      agents.some((agent) => agent.usage.scanning)
    ),
    agents
  };
}
