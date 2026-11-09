import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectAtriaSystemMessage } from "../domain/agent-identity.js";
import { recordingProducer, sanitizeRecording } from "./model-request-recorder.js";

type Row = Record<string, unknown>;
interface Entry extends Row {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
}
interface AuditMessage {
  messageId: string;
  parentEntryId: string | null;
  occurredAt?: string;
  inCurrentBranch: boolean;
  role: string;
  content: unknown;
  instructionSections?: unknown;
  metadata: Row;
}
function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
export interface SessionExportInput {
  sessionId: string;
  name?: string;
  projectDirectory: string;
  taskId?: string;
  runId?: string;
  task?: unknown;
  artifacts?: unknown[];
  entries: readonly unknown[];
  branchEntryIds: readonly string[];
  secrets?: readonly string[];
}

/** Validate every branch before SDK traversal. V1 IDs are assigned by temporary-copy migration. */
export function validateSessionExportEntries(
  entries: readonly unknown[],
  options: { legacy?: boolean } = {}
) {
  if (!Array.isArray(entries)) throw new Error("无效的会话记录结构，原文件已保留。");
  const byId = new Map<string, Entry>();
  for (const value of entries) {
    const entry = object(value);
    if (typeof entry.type !== "string" || !entry.type.trim() || entry.type === "session")
      throw new Error("无效的会话记录结构，原文件已保留。");
    if (entry.type === "message") {
      const message = object(entry.message);
      if (typeof message.role !== "string" || !message.role.trim())
        throw new Error("无效的会话记录结构，原文件已保留。");
    }
    if (options.legacy) continue;
    if (
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      byId.has(entry.id) ||
      (entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId.trim()))
    )
      throw new Error("会话记录的 ID 或父引用无效，原文件已保留。");
    byId.set(entry.id, entry as Entry);
  }
  const complete = new Set<string>();
  for (const start of byId.keys()) {
    const path = new Set<string>();
    let id: string | null = start;
    while (id !== null && !complete.has(id)) {
      if (path.has(id)) throw new Error("会话记录的父引用形成循环，原文件已保留。");
      const entry = byId.get(id);
      if (!entry) throw new Error("会话记录引用了不存在的父记录，原文件已保留。");
      path.add(id);
      id = entry.parentId;
    }
    for (const id of path) complete.add(id);
  }
}

/** Read existing metadata only. Export must not scan, migrate or create Task state. */
export async function readSessionExportMetadata(workspaceRoot: string, taskId?: string) {
  if (!taskId) return {};
  if (!/^[a-zA-Z0-9._-]+$/.test(taskId) || [".", ".."].includes(taskId))
    throw new Error("无效的导出任务 ID。");
  const read = async (path: string): Promise<Row | undefined> => {
    try {
      return object(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new Error("会话关联的任务元数据无效，原文件已保留。");
      throw error;
    }
  };
  const task = await read(join(workspaceRoot, taskId, "task.json"));
  const index = await read(join(workspaceRoot, taskId, ".runtime", "artifacts.json"));
  return {
    task,
    runId: typeof task?.activeRunId === "string" ? task.activeRunId : undefined,
    artifacts: Array.isArray(index?.entries)
      ? index.entries.map((entry: unknown) => object(entry).artifact)
      : []
  };
}

export async function createSessionExport(input: SessionExportInput) {
  validateSessionExportEntries(input.entries);
  const entries = input.entries as Entry[];
  const branch = new Set(input.branchEntryIds);
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const callIds = new Map(
    entries.map((entry) => {
      const message = object(entry.message);
      const parts = message.role === "assistant" && Array.isArray(message.content) ? message.content : [];
      return [
        entry.id,
        new Set(
          parts
            .map(object)
            .filter((part) => part.type === "toolCall")
            .map((part) => part.id)
        )
      ];
    })
  );
  const messages: AuditMessage[] = [];
  const events: Row[] = [];
  for (const entry of entries) {
    const common = {
      messageId: entry.id,
      parentEntryId: entry.parentId ?? null,
      occurredAt: entry.timestamp,
      inCurrentBranch: branch.has(entry.id)
    };
    if (entry.type === "message" || entry.type === "custom_message") {
      const message: Row =
        entry.type === "message"
          ? object(projectAtriaSystemMessage(entry.message))
          : {
              role: "notice",
              content: entry.content,
              customType: entry.customType,
              details: entry.details,
              display: entry.display
            };
      const { role, content, sections, ...metadata } = message;
      messages.push({
        ...common,
        role: typeof role === "string" ? role : "unknown",
        content,
        ...(sections ? { instructionSections: sections } : {}),
        metadata
      });
    } else {
      const { id, parentId, timestamp, type, ...data } = entry;
      if (type === "compaction" && data.systemMessage !== undefined)
        data.systemMessage = projectAtriaSystemMessage(data.systemMessage);
      events.push({
        eventId: id,
        parentEntryId: parentId ?? null,
        occurredAt: timestamp,
        inCurrentBranch: branch.has(id),
        type,
        data
      });
    }
  }
  const belongsToCall = (resultId: string, callId: string, toolCallId: unknown) => {
    const visited = new Set<string>();
    let id: string | null = resultId;
    while (id && !visited.has(id)) {
      if (id === callId) return true;
      // Providers may reuse IDs in later assistant turns. The nearest call
      // with this ID owns the result; do not attach it to an older ancestor.
      if (callIds.get(id)?.has(toolCallId)) return false;
      visited.add(id);
      id = entryMap.get(id)?.parentId ?? null;
    }
    return false;
  };
  const toolCalls: Row[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const part = object(value);
      if (part.type !== "toolCall") continue;
      const results = messages.filter(
        (result) =>
          result.role === "toolResult" &&
          result.metadata.toolCallId === part.id &&
          belongsToCall(result.messageId, message.messageId, part.id)
      );
      const preferred = results.find((result) => result.inCurrentBranch) ?? results.at(0);
      toolCalls.push({
        toolCallId: part.id,
        name: part.name,
        arguments: part.arguments,
        messageId: message.messageId,
        inCurrentBranch: message.inCurrentBranch,
        resultMessageId: preferred?.messageId,
        resultMessageIds: results.map((result) => result.messageId),
        status: !preferred ? "unresolved" : preferred.metadata.isError ? "failed" : "completed"
      });
    }
  }
  return sanitizeRecording(
    {
      schemaVersion: 1,
      format: "atria.session",
      producer: await recordingProducer(),
      exportedAt: new Date().toISOString(),
      session: {
        sessionId: input.sessionId,
        name: input.name,
        projectDirectory: input.projectDirectory,
        taskId: input.taskId,
        runId: input.runId
      },
      task: input.task,
      messages,
      toolCalls,
      events,
      artifacts: input.artifacts ?? []
    },
    input.secrets
  ) as {
    schemaVersion: number;
    format: string;
    producer: Row;
    exportedAt: string;
    session: Row;
    task?: unknown;
    messages: AuditMessage[];
    toolCalls: Row[];
    events: Row[];
    artifacts: unknown[];
  };
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
  );
}

/** A passive, standalone audit page: no scripts, external assets or HTML from the transcript. */
export function sessionExportHtml(data: Awaited<ReturnType<typeof createSessionExport>>) {
  const text = (message: AuditMessage) => {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content))
      return message.content
        .map((value: unknown) => {
          const part = object(value);
          if (part.type === "text") return String(part.text ?? "");
          if (part.type === "thinking") return String(part.thinking ?? "");
          if (part.type === "toolCall") return `${part.name}\n${JSON.stringify(part.arguments, null, 2)}`;
          return `[${part.type ?? "content"}]`;
        })
        .join("\n\n");
    if (message.role === "bashExecution")
      return `${message.metadata.command}\n${message.metadata.output}\nexitCode=${message.metadata.exitCode}`;
    return "";
  };
  const title = `${data.session.name || data.session.sessionId} · CoworkOS`;
  const messages = data.messages
    .filter((message) => message.inCurrentBranch && message.role !== "system")
    .map(
      (message) =>
        `<article><h2>${escapeHtml(message.role)}</h2><pre>${escapeHtml(text(message))}</pre></article>`
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(String(title))}</title><style>body{max-width:960px;margin:40px auto;padding:0 24px;font:16px system-ui;color:#202020}article{border-top:1px solid #ddd;padding:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}h2{font-size:16px}</style></head><body><h1>${escapeHtml(String(title))}</h1><p>CoworkOS ${escapeHtml(String(data.producer.version))} · ${escapeHtml(data.exportedAt)}</p>${messages}<details><summary>Complete audit data (all branches)</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details></body></html>\n`;
}

export async function writeSessionExport(
  input: SessionExportInput & {
    format?: "json" | "html";
    outputPath?: string;
    directory?: string;
    force?: boolean;
  }
) {
  const format = input.format ?? "json";
  if (!["json", "html"].includes(format)) throw new Error("导出格式须为 json 或 html。");
  const id = input.sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const outputPath = resolve(
    input.directory ?? input.projectDirectory,
    input.outputPath ?? `coworkos-session-${id}.${format}`
  );
  const data = await createSessionExport(input);
  const serialized = format === "json" ? `${JSON.stringify(data, null, 2)}\n` : sessionExportHtml(data);
  try {
    const file = await open(outputPath, input.force ? "w" : "wx", 0o600);
    try {
      // Creation mode does not affect existing files. Restrict the opened inode
      // before writing private content, including explicit forced overwrites.
      await file.chmod(0o600);
      await file.writeFile(serialized, "utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("导出文件已存在；换一个文件名，或显式使用 --force。");
    throw error;
  }
  return { format, outputPath, sessionId: input.sessionId };
}
