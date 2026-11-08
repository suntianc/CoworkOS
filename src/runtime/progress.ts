import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { listTaskArtifacts } from "../workspace/artifact-store.js";
import { agentDisplayName } from "./agent-identity.js";

export interface SubagentProgress {
  callId: string;
  agentId: string;
  name: string;
  task: string;
  mode?: "sync" | "async" | "auto";
  /** Role this work item runs as; omitted for a delegation with no role request. */
  role?: "executor" | "reviewer";
  /** Model and connection the latest attempt actually selected (no endpoint or key). */
  model?: string;
  connectionName?: string | null;
  /** The project directory this item runs against: its development checkout when bound. */
  workspace?: string;
  /** Work items this one waits for. */
  dependsOn?: string[];
  /** True while this item is waiting and a prerequisite has not finished. */
  blocked?: boolean;
  /** The requirement development this item belongs to, when it is bound to one. */
  developmentId?: string;
  /** Why the item ended without a result; the durable queue's own reason. */
  error?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "unknown";
  updatedAt?: string;
  latestEvent?: string;
  lastActivity?: string;
  artifacts: string[];
  outputFiles: string[];
  diagnostics: { tracePath: string; resultPath: string };
  /** Counts cover sampled trace bytes when a legacy trace exceeds the read budget. */
  traceSampled?: boolean;
  callbackPending: boolean;
  pendingMessages: number;
  turns: number;
  messageCount: number;
  elapsedMs?: number;
  lastTool?: string;
  lastAssistantText?: string;
}

export interface SubagentStatusSnapshot {
  taskId: string;
  runId: string;
  summary: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    cancelled: number;
    callbackPending: number;
  };
  agents: SubagentProgress[];
}

/** Expose durable Coordinator state as a small read-only Main tool. */
export function createSubagentStatusTool(input: {
  workspaceRoot: string;
  taskId: string;
  runId: string;
}): AgentTool {
  return {
    name: "get_subagent_status",
    label: "get_subagent_status",
    description:
      "Return compact structured progress for Subagents in this Task Run: task, mode, status, latest event, last trace activity, candidate outputFiles, diagnostic paths, accepted artifacts and pending callbacks. outputFiles remain in the agent workspace; use browse_workspace to inspect them before promoting final files to Task artifacts/. This is read-only.",
    parameters: Type.Object({ agentId: Type.Optional(Type.String()) }),
    execute: async (_toolCallId, params) => {
      const value = params as { agentId?: unknown };
      const snapshot = await readSubagentProgress({
        ...input,
        agentId: typeof value?.agentId === "string" ? value.agentId : undefined
      });
      return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
    }
  };
}

/** Read durable progress and candidate files directly from their agent workspaces. */
export async function readSubagentProgress(input: {
  workspaceRoot: string;
  taskId: string;
  runId: string;
  agentId?: string;
}): Promise<SubagentStatusSnapshot> {
  const runRoot = join(input.workspaceRoot, input.taskId, "runs", input.runId);
  const queue = await readJson<
    Array<{
      stepId: string;
      agentId: string;
      status: string;
      payload?: {
        task?: string;
        delegation?: { role?: string };
        projectDirectory?: string;
        dependsOn?: string[];
        developmentId?: string;
      };
      error?: string;
      createdAt?: string;
      updatedAt?: string;
    }>
  >(join(runRoot, "queue.json"), []);
  // One predicate for every terminal queue state, matching normalizeStatus.
  const terminalCall = (status: string | undefined) =>
    status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
  const events = await readJsonLines(join(runRoot, "run_events.jsonl"));
  const inbox = await readJson<Array<{ callId?: string; state: string }>>(
    join(runRoot, "agents", "main", "inbox-store.json"),
    []
  );
  const taskArtifacts = await listTaskArtifacts(input);
  const agents = await Promise.all(
    queue
      .filter((item) => !input.agentId || item.agentId === input.agentId)
      .map(async (item): Promise<SubagentProgress> => {
        const related = events.filter((event) => event.callId === item.stepId);
        const latest = related.at(-1);
        const call = related.find((event) => event.type === "call.accepted")?.payload as
          { call?: { mode?: SubagentProgress["mode"] } } | undefined;
        const artifacts = taskArtifacts
          .filter((artifact) => artifact.runId === input.runId && artifact.producerAgentId === item.agentId)
          .map((artifact) => artifact.relativePath);
        const outputFiles = await listAgentOutputFiles({ ...input, agentId: item.agentId });
        const diagnostics = {
          tracePath: `sessions/${item.agentId}/${input.runId}.jsonl`,
          resultPath: `runs/${input.runId}/agents/subagents/${item.agentId}/result.json`
        };
        const callbackPending = inbox.some(
          (message) =>
            message.callId === item.stepId && (message.state === "ready" || message.state === "leased")
        );
        const pendingMessages = await countPendingMessages(
          join(runRoot, "agents", "subagents", item.agentId, "inbox-store.json")
        );
        const trace = await readTraceSummary(
          join(input.workspaceRoot, input.taskId, "sessions", item.agentId, `${input.runId}.jsonl`)
        );
        const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(item.status);
        const elapsedMs = item.createdAt
          ? Math.max(
              0,
              Date.parse(terminal ? (item.updatedAt ?? item.createdAt) : new Date().toISOString()) -
                Date.parse(item.createdAt)
            )
          : undefined;
        const dependsOn = item.payload?.dependsOn ?? [];
        // This item's own outcome comes first: a cancelled or finished item is
        // not blocked by a prerequisite that is still running, and its state
        // must not read as waiting.
        const blocked =
          !terminalCall(item.status) &&
          dependsOn.some(
            (stepId) => !terminalCall(queue.find((candidate) => candidate.stepId === stepId)?.status)
          );
        const selected = related.filter((event) => event.type === "call.model_selected").at(-1)?.payload as
          { modelSelection?: { role?: string; model?: string; connectionName?: string | null } } | undefined;
        const selection = selected?.modelSelection;
        const role = selection?.role ?? item.payload?.delegation?.role;
        return {
          callId: item.stepId,
          agentId: item.agentId,
          name: agentDisplayName(item.agentId),
          task: item.payload?.task ?? "",
          mode: call?.call?.mode,
          // A blocked item is waiting, not working: it must not read as running.
          status: blocked ? "queued" : normalizeStatus(item.status),
          ...(role === "executor" || role === "reviewer" ? { role } : {}),
          ...(selection?.model ? { model: selection.model } : {}),
          ...(selection?.connectionName ? { connectionName: selection.connectionName } : {}),
          ...(item.payload?.projectDirectory ? { workspace: item.payload.projectDirectory } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          ...(blocked ? { blocked: true } : {}),
          ...(item.payload?.developmentId ? { developmentId: item.payload.developmentId } : {}),
          ...(item.error ? { error: item.error } : {}),
          updatedAt: item.updatedAt,
          latestEvent: latest?.type,
          lastActivity: trace.lastActivity,
          artifacts,
          outputFiles,
          diagnostics,
          traceSampled: trace.sampled || undefined,
          callbackPending,
          pendingMessages,
          turns: trace.turns,
          messageCount: trace.messageCount,
          elapsedMs,
          lastTool: trace.lastTool,
          lastAssistantText: trace.lastAssistantText
        };
      })
  );
  const summary = {
    total: agents.length,
    queued: agents.filter((agent) => agent.status === "queued").length,
    running: agents.filter((agent) => agent.status === "running").length,
    succeeded: agents.filter((agent) => agent.status === "succeeded").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    timedOut: agents.filter((agent) => agent.status === "timed_out").length,
    cancelled: agents.filter((agent) => agent.status === "cancelled").length,
    callbackPending: agents.filter((agent) => agent.callbackPending).length
  };
  return { taskId: input.taskId, runId: input.runId, summary, agents };
}

function normalizeStatus(status: string): SubagentProgress["status"] {
  if (status === "queued") return "queued";
  if (status === "leased") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "timed_out") return "timed_out";
  if (status === "cancelled") return "cancelled";
  return "unknown";
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function readJsonLines(
  path: string
): Promise<Array<{ type?: string; callId?: string; payload?: unknown }>> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { type?: string; callId?: string; payload?: unknown }];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

interface TraceSummary {
  lastActivity?: string;
  turns: number;
  messageCount: number;
  lastTool?: string;
  lastAssistantText?: string;
  sampled?: boolean;
}
interface TraceSummaryCache {
  offset: number;
  ino?: number;
  mtimeMs?: number;
  pending: Buffer;
  skipLine: boolean;
  summary: TraceSummary;
  busy?: Promise<void>;
}
const traceSummaries = new Map<string, TraceSummaryCache>();
const TRACE_READ_BUDGET = 4 * 1024 * 1024;
const TRACE_LINE_BUDGET = 1024 * 1024;

/** Refresh only appended bytes. Old multi-GB traces use a bounded tail so a
 * status/UI refresh never loads a full model transcript into memory. */
async function readTraceSummary(path: string): Promise<TraceSummary> {
  let cache = traceSummaries.get(path);
  if (!cache) {
    cache = { offset: 0, pending: Buffer.alloc(0), skipLine: false, summary: { turns: 0, messageCount: 0 } };
    traceSummaries.set(path, cache);
    if (traceSummaries.size > 32) traceSummaries.delete(traceSummaries.keys().next().value!);
  }
  const current = cache;
  try {
    if (!current.busy) {
      current.busy = updateTraceSummary(path, current).finally(() => {
        current.busy = undefined;
      });
    }
    await current.busy;
    return { ...current.summary };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { turns: 0, messageCount: 0 };
    return { ...current.summary, lastActivity: "activity unavailable" };
  }
}

async function updateTraceSummary(path: string, cache: TraceSummaryCache): Promise<void> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (
      cache.ino !== info.ino ||
      info.size < cache.offset ||
      (info.size === cache.offset && cache.mtimeMs !== info.mtimeMs)
    ) {
      cache.offset = 0;
      cache.pending = Buffer.alloc(0);
      cache.skipLine = false;
      cache.summary = { turns: 0, messageCount: 0 };
    }
    cache.ino = info.ino;
    cache.mtimeMs = info.mtimeMs;
    if (info.size - cache.offset > TRACE_READ_BUDGET) {
      cache.offset = info.size - TRACE_READ_BUDGET;
      cache.pending = Buffer.alloc(0);
      cache.skipLine = true;
      cache.summary.sampled = true;
    }
    const length = info.size - cache.offset;
    if (length <= 0) return;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, cache.offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    cache.offset += read;
    const data = Buffer.concat([cache.pending, buffer.subarray(0, read)]);
    let start = 0;
    for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
      if (cache.skipLine) cache.skipLine = false;
      else if (end - start > TRACE_LINE_BUDGET) cache.summary.sampled = true;
      else consumeTraceSummary(cache.summary, data.subarray(start, end).toString("utf8"));
      start = end + 1;
    }
    if (data.length - start > TRACE_LINE_BUDGET || cache.skipLine) {
      cache.pending = Buffer.alloc(0);
      cache.skipLine = true;
      cache.summary.sampled = true;
    } else {
      cache.pending = Buffer.from(data.subarray(start));
    }
  } finally {
    await file.close();
  }
}

function consumeTraceSummary(summary: TraceSummary, line: string): void {
  let record: {
    occurredAt?: string;
    payload?: {
      type?: unknown;
      toolName?: unknown;
      toolCall?: { name?: unknown };
      message?: { role?: unknown; content?: unknown };
    };
  };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return;
  }
  const payload = record.payload ?? {};
  const type = typeof payload.type === "string" ? payload.type : "activity";
  if (type === "turn_start") summary.turns += 1;
  if (type === "message_end") summary.messageCount += 1;
  const tool =
    typeof payload.toolName === "string"
      ? payload.toolName
      : typeof payload.toolCall?.name === "string"
        ? payload.toolCall.name
        : undefined;
  if (tool) summary.lastTool = tool;
  if (payload.message?.role === "assistant") {
    const text = textFromContent(payload.message.content);
    if (text) summary.lastAssistantText = text.slice(-800);
  }
  summary.lastActivity = `${type}${tool ? `:${tool}` : ""}${record.occurredAt ? ` @ ${record.occurredAt}` : ""}`;
}

/** Candidate outputs are readable in place; they never become Task artifacts
 * merely because a Subagent completed. Symlinks are not followed. */
export async function listAgentOutputFiles(input: {
  workspaceRoot: string;
  taskId: string;
  agentId: string;
}): Promise<string[]> {
  if (
    ![input.taskId, input.agentId].every(
      (value) => /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== ".."
    )
  ) {
    throw new Error("unsafe task or agent id");
  }
  const segments = [input.taskId, "agents", "subagents", input.agentId, "deliverables"];
  let root = input.workspaceRoot;
  try {
    for (const segment of segments) {
      root = join(root, segment);
      const info = await lstat(root);
      if (info.isSymbolicLink() || !info.isDirectory()) return [];
    }
    const prefix = `agents/subagents/${input.agentId}/deliverables`;
    return await outputFilesInDirectory(root, prefix);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function outputFilesInDirectory(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await outputFilesInDirectory(join(root, entry.name), path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function countPendingMessages(path: string): Promise<number> {
  const messages = await readJson<Array<{ state?: string }>>(path, []);
  return messages.filter((message) => message.state === "ready" || message.state === "leased").length;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("")
    .trim();
}
