import {
  beginMessageEditTransaction,
  recordMessageEditBranch,
  rollbackMessageEditTransaction
} from "./main-message-edit-transaction.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile, realpath } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { conversationMessages, type ConversationMessage } from "./conversation-view.js";
import { readTaskRuntimeEvents } from "./conversation-history.js";
import { mainContextPaths, persistMainContext } from "./main-context.js";
import { readMainInput, mainInputPath, type MainInput } from "./main-continuation.js";
import { readTaskInput, type InputFile } from "../workspace/input-store.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { mainRequestEnvironment } from "./main-request-retry.js";
import { mainRequestPath } from "../storage/main-request-store.js";
import { readQueuedUserTurn } from "./queued-user-turn.js";
import { HumanRequestStore } from "./human.js";

export class MainMessageEditConflict extends Error {
  readonly status = 409;
  readonly code = "main_message_edit_conflict";
}
export interface EditTextFile {
  name: string;
  text: string;
  size: number;
}
export interface MessageEditTarget {
  messageId: string;
  scopeToken: string;
  versionId: string;
  runId: string;
  body: string;
  attachments: Array<InputFile | EditTextFile>;
}
export interface MessageEditRequest {
  messageId: string;
  scopeToken: string;
  versionId: string;
  runId: string;
  editId: string;
}
interface ArchivedVersion {
  versionId: string;
  messageId: string;
  sessionFile: string;
  replacedBy: string;
  retrySnapshotPath?: string;
  messages?: ConversationMessage[];
  runtimeEvents?: Record<string, unknown>[];
  historyFile?: string;
  currentMessageId?: string;
  groupId?: string;
  preview?: string;
  createdAt?: string;
  activityCount?: number;
}
interface Versions {
  version: 1;
  taskId: string;
  versionId: string;
  sessionFile: string;
  excludedRuns: string[];
  prefixEvents: Record<string, unknown>[];
  archives: ArchivedVersion[];
  edits: Array<{ editId: string; runId: string; prompt: string; target: MessageEditRequest }>;
}
export async function saveAcceptedMainMessage(root: string, taskId: string, input: MainInput) {
  if (input.source === "human" || !input.messageId) return;
  const directory = join(root, taskId, "sessions", "main", "user-inputs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${input.messageId}.json`),
    JSON.stringify({ ...input, taskId, accepted: true }),
    { mode: 0o600, flag: "wx" }
  );
}
export async function rejectAcceptedMainMessage(root: string, taskId: string, messageId: string) {
  const path = join(root, taskId, "sessions", "main", "user-inputs", `${messageId}.json`);
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...value, accepted: false }), { mode: 0o600 });
}
async function durableMainMessages(
  root: string,
  taskId: string
): Promise<Array<MainInput & { accepted: boolean }>> {
  const directory = join(root, taskId, "sessions", "main", "user-inputs");
  const files = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const values = await Promise.all(
    files
      .filter((file) => /^[a-zA-Z0-9._-]+\.json$/.test(file))
      .map(async (file) => {
        const value = JSON.parse(await readFile(join(directory, file), "utf8"));
        if (
          value.version !== 1 ||
          value.taskId !== taskId ||
          typeof value.messageId !== "string" ||
          `${value.messageId}.json` !== file ||
          typeof value.prompt !== "string" ||
          !Number.isFinite(value.submittedAt) ||
          !["composer", "inbox"].includes(value.source) ||
          typeof value.accepted !== "boolean"
        )
          throw new Error("主动用户输入记录无法恢复，历史已保留。");
        return value as MainInput & { accepted: boolean };
      })
  );
  return values;
}
const versionsPath = (root: string, taskId: string) =>
  join(root, taskId, "sessions", "main", "versions.json");
export async function readMessageVersions(root: string, taskId: string): Promise<Versions | undefined> {
  try {
    const value = JSON.parse(await readFile(versionsPath(root, taskId), "utf8")) as Versions;
    const sessionDirectory = join(resolve(root), taskId, "sessions", "main", "pi");
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- versions.json 从磁盘读出，旧版本文件的 version 不是 1 时必须拒绝恢复
      value.version !== 1 ||
      value.taskId !== taskId ||
      dirname(resolve(value.sessionFile)) !== sessionDirectory ||
      !Array.isArray(value.archives) ||
      !Array.isArray(value.edits) ||
      !Array.isArray(value.excludedRuns) ||
      !Array.isArray(value.prefixEvents)
    )
      throw new Error("会话版本记录无法恢复，已保留历史。");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
/** An explicit version must follow a deliberate project-folder change too. */
export async function alignMessageVersionSession(
  root: string,
  taskId: string,
  projectDirectory: string,
  versions: Versions
): Promise<Versions> {
  const target = await realpath(resolve(projectDirectory));
  const directory = join(root, taskId, "sessions/main/pi");
  const session = SessionManager.open(versions.sessionFile, directory);
  if (resolve(session.getCwd()) === target) return versions;
  const fork = SessionManager.forkFrom(versions.sessionFile, target, directory);
  const sessionFile = fork.getSessionFile()!;
  // The SDK defers an empty branch until an assistant response; flush before spawn.
  const temporary = `${sessionFile}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    [fork.getHeader(), ...fork.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { mode: 0o600 }
  );
  await rename(temporary, sessionFile);
  const next = { ...versions, sessionFile };
  await atomicJson(versionsPath(root, taskId), next);
  return next;
}
export function messageVersionSummaries(versions?: Versions) {
  return (
    versions?.archives.map((archive) => ({
      versionId: archive.versionId,
      messageId: archive.messageId,
      currentMessageId: archive.currentMessageId,
      groupId: archive.groupId,
      replacedBy: archive.replacedBy,
      preview: archive.preview,
      createdAt: archive.createdAt,
      activityCount: archive.activityCount ?? archive.runtimeEvents?.length ?? 0
    })) ?? []
  );
}
export async function readArchivedMessageVersion(root: string, taskId: string, versionId: string) {
  const archive = (await readMessageVersions(root, taskId))?.archives.find(
    (value) => value.versionId === versionId
  );
  if (!archive) return;
  if (!archive.historyFile)
    return { messages: archive.messages ?? [], runtimeEvents: archive.runtimeEvents ?? [] };
  if (basename(archive.historyFile) !== archive.historyFile || archive.historyFile !== `${versionId}.json`)
    throw new MainMessageEditConflict("历史版本路径无效，记录已保留。");
  const value = JSON.parse(
    await readFile(join(root, taskId, "sessions/main/message-versions", archive.historyFile), "utf8")
  );
  if (!Array.isArray(value.messages) || !Array.isArray(value.runtimeEvents))
    throw new MainMessageEditConflict("历史版本无法读取，记录已保留。");
  return { messages: value.messages, runtimeEvents: value.runtimeEvents };
}
async function externalizeArchives(root: string, taskId: string, archives: ArchivedVersion[]) {
  const directory = join(root, taskId, "sessions/main/message-versions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return Promise.all(
    archives.map(async ({ messages, runtimeEvents, ...archive }) => {
      if (archive.historyFile) return archive;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(archive.versionId))
        throw new MainMessageEditConflict("历史版本标识无效，记录已保留。");
      const historyFile = `${archive.versionId}.json`;
      await atomicJson(join(directory, historyFile), {
        messages: messages ?? [],
        runtimeEvents: runtimeEvents ?? []
      });
      return { ...archive, historyFile, activityCount: archive.activityCount ?? runtimeEvents?.length ?? 0 };
    })
  );
}
export function versionRuntimeEvents(events: Record<string, unknown>[], versions?: Versions) {
  return versions
    ? [
        ...versions.prefixEvents,
        ...events.filter((event) => !versions.excludedRuns.includes(String(event.runId)))
      ]
    : events;
}
function userText(entry: SessionEntry): string | undefined {
  if (entry.type === "custom_message" && entry.customType === "cowork-user-message") {
    const details = entry.details as { message?: string } | undefined;
    return details?.message;
  }
  if (entry.type !== "message" || entry.message.role !== "user") return;
  const content = entry.message.content;
  return (
    readQueuedUserTurn(content)?.text ??
    (typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""))
  );
}
/** The Pi session the next Main run continues: the edited version, else the most recent file. */
export async function currentMainSession(root: string, taskId: string) {
  const versions = await readMessageVersions(root, taskId);
  const directory = join(root, taskId, "sessions", "main", "pi");
  const files = versions
    ? []
    : await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
  const recent = await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
      .map(async (file) => ({
        path: join(directory, file.name),
        modified: (await stat(join(directory, file.name))).mtimeMs
      }))
  );
  const file = versions?.sessionFile ?? recent.sort((a, b) => b.modified - a.modified)[0]?.path;
  return { versions, session: file ? SessionManager.open(file, directory) : undefined };
}
/** Editable identities are accepted composer inputs or persisted Inbox submissions, never arbitrary Pi user messages. */
export async function latestEditableMessage(root: string, taskId: string, runId?: string) {
  if (!runId) return;
  const { versions, session } = await currentMainSession(root, taskId);
  if (!session) return;
  const allEvents = await readTaskRuntimeEvents(root, taskId);
  const events = versionRuntimeEvents(allEvents, versions);
  const runIds = [...new Set(events.map((event) => String(event.runId)))];
  if (!runIds.includes(runId)) runIds.push(runId);
  const inputs = (
    await Promise.all(
      runIds.map(async (id) => ({ runId: id, input: await readMainInput(mainInputPath(root, taskId, id)) }))
    )
  ).filter((record) => record.input && record.input.source !== "human");
  const durableRecords = await durableMainMessages(root, taskId);
  const durableInputs = durableRecords.filter((input) => input.accepted);
  // Durable decisions supersede every legacy fallback, including explicitly rejected launches.
  const durableIds = new Set(durableRecords.map((input) => input.messageId));
  const rejectedIds = new Set(
    durableRecords.filter((input) => !input.accepted).map((input) => input.messageId)
  );
  const cancelled = new Set(
    events
      .filter((event) => event.type === "user.message_cancelled")
      .map((event) => (event.payload as { messageId?: string }).messageId)
  );
  const accepted = [
    ...durableInputs.map((input) => ({
      time: input.submittedAt,
      text: readQueuedUserTurn(input.prompt)?.text ?? input.prompt,
      body: input.body,
      runId: input.runId,
      messageId: input.messageId
    })),
    ...inputs
      .filter((record) => !durableIds.has(record.input!.messageId))
      .map((record) => ({
        time: record.input!.submittedAt,
        text: readQueuedUserTurn(record.input!.prompt)?.text ?? record.input!.prompt,
        body: record.input!.body,
        runId: record.runId,
        messageId: record.input!.messageId
      })),
    ...events
      .filter(
        (event) =>
          event.type === "user.interjected" &&
          !rejectedIds.has((event.payload as { messageId?: string }).messageId) &&
          !cancelled.has((event.payload as { messageId?: string }).messageId)
      )
      .map((event) => {
        const payload = event.payload as { message: string; messageId: string; createdAt: string };
        return {
          time: Date.parse(payload.createdAt || String(event.occurredAt)),
          text: payload.message,
          body: undefined,
          runId: String(event.runId),
          messageId: payload.messageId
        };
      })
  ].sort((a, b) => b.time - a.time);
  const latest = accepted[0];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- accepted 由输入事件与快照拼出，任务还没有任何用户输入时数组为空
  if (!latest) return;
  const entry = session.getBranch().find((entry) => {
    if (userText(entry) !== latest.text || Date.parse(entry.timestamp) < latest.time - 1000) return false;
    const identity =
      entry.type === "message" && entry.message.role === "user"
        ? readQueuedUserTurn(entry.message.content)?.messageId
        : entry.type === "custom_message"
          ? (entry.details as { _coworkInbox?: { messageId?: string } } | undefined)?._coworkInbox?.messageId
          : undefined;
    return latest.messageId ? identity === latest.messageId : true;
  });
  if (!entry) return; // A queued or pre-spawn input has not entered Pi yet.
  let body = latest.body ?? latest.text;
  const attachments: Array<InputFile | EditTextFile> = [];
  let inlineSource = latest.text;
  const marker = "\n\n<atria_uploaded_files>\n";
  const boundary = latest.text.lastIndexOf(marker);
  if (boundary >= 0 && latest.text.endsWith("\n</atria_uploaded_files>")) {
    const manifest = JSON.parse(
      latest.text.slice(boundary + marker.length, -"\n</atria_uploaded_files>".length)
    );
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10)
      throw new Error("原消息附件引用无效。");
    for (const file of manifest.files)
      attachments.push((await readTaskInput(join(root, taskId), file.uploadId)).file);
    body = latest.body ?? latest.text.slice(0, boundary);
    inlineSource = latest.text.slice(0, boundary);
  }
  const inlineMarker = "\n\nAttached files:\n";
  const inlineBoundary = inlineSource.indexOf(inlineMarker);
  if (inlineBoundary >= 0) {
    const sections = inlineSource
      .slice(inlineBoundary + inlineMarker.length)
      .split(/\n\n(?=--- [^\n]+ ---\n)/);
    const files = sections.map((section) => /^--- ([^\n]+) ---\n([\s\S]*)$/.exec(section));
    if (
      files.length <= 3 &&
      files.every(
        (file) => file && !/[\\/\0]/.test(file[1]) && Buffer.byteLength(file[2], "utf8") <= 128 * 1024
      )
    ) {
      attachments.unshift(
        ...files.map((file) => ({
          name: file![1],
          text: file![2],
          size: Buffer.byteLength(file![2], "utf8")
        }))
      );
      body = latest.body ?? inlineSource.slice(0, inlineBoundary);
    }
  }
  const task = await new LocalWorkspaceStore(root).readTask(taskId);
  const scopeToken = createHash("sha256")
    .update(JSON.stringify(await mainRequestEnvironment(root, taskId, task.projectDirectory ?? root)))
    .digest("hex");
  return {
    target: {
      scopeToken,
      messageId: latest.messageId ?? entry.id,
      versionId: versions?.versionId ?? session.getSessionId(),
      runId,
      body,
      attachments
    } satisfies MessageEditTarget,
    entry,
    session,
    versions,
    events,
    allEvents
  };
}
/** Caller holds the Task's idle/project lock. A branch copies only the prefix, retaining the old immutable session. */
export async function prepareMessageEdit(
  root: string,
  taskId: string,
  request: MessageEditRequest,
  prompt: string,
  runId: string,
  replacementMessageId?: string
) {
  const existing = await readMessageVersions(root, taskId);
  const repeated = existing?.edits.find((edit) => edit.editId === request.editId);
  if (repeated) {
    if (repeated.prompt !== prompt || JSON.stringify(repeated.target) !== JSON.stringify(request))
      throw new MainMessageEditConflict("该重发标识已用于其他输入，请刷新后重试。");
    return { repeatedRunId: repeated.runId, rollback: undefined, goalForTask: undefined };
  }
  const source = await latestEditableMessage(root, taskId, request.runId);
  if (
    !source ||
    source.target.messageId !== request.messageId ||
    source.target.versionId !== request.versionId ||
    source.target.scopeToken !== request.scopeToken
  )
    throw new MainMessageEditConflict("可编辑的消息或会话版本已变化，编辑内容仍保留，请刷新后重试。");
  const { session, entry, versions, events, allEvents } = source;
  const retrySnapshot = await readFile(mainRequestPath(root, taskId), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  );
  const sourceFile = session.getSessionFile()!;
  const archivedMessages = conversationMessages(session.getBranch());
  const human = new HumanRequestStore(root);
  const retiredHumanRequests = (await human.list(taskId))
    .filter(
      (question) =>
        question.runId === request.runId &&
        Date.parse(question.createdAt) >= Date.parse(entry.timestamp) &&
        (question.status === "pending" || question.status === "unanswered")
    )
    .map((question) => question.requestId);
  await beginMessageEditTransaction(
    root,
    taskId,
    runId,
    {
      version: 1,
      taskId,
      versionId: source.target.versionId,
      sessionFile: sourceFile,
      excludedRuns: [],
      prefixEvents: [],
      archives: [],
      edits: []
    },
    { editId: request.editId, prompt },
    retiredHumanRequests
  );
  try {
    for (const requestId of retiredHumanRequests) await human.supersede(taskId, requestId, runId);
    let sessionFile: string;
    if (entry.parentId) {
      sessionFile = session.createBranchedSession(entry.parentId)!;
      // Model/settings entries can precede the first user message. That prefix
      // has no assistant, so the SDK also defers this branched file.
      const temporary = `${sessionFile}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        [session.getHeader(), ...session.getEntries()].map((value) => JSON.stringify(value)).join("\n") +
          "\n",
        { mode: 0o600, flag: "wx" }
      );
      await rename(temporary, sessionFile);
    } else {
      const fresh = SessionManager.create(session.getCwd(), session.getSessionDir());
      fresh.appendCustomEntry("cowork-message-edit", { sourceFile, messageId: entry.id });
      sessionFile = fresh.getSessionFile()!;
      // Pi persists an empty session lazily; ensure its header and audit entry exist before spawn.
      await writeFile(
        sessionFile,
        [fresh.getHeader(), ...fresh.getEntries()].map((value) => JSON.stringify(value)).join("\n") + "\n",
        { mode: 0o600 }
      );
    }
    await recordMessageEditBranch(root, taskId, sessionFile);
    const branch = SessionManager.open(sessionFile).getBranch();
    const cutoff = events.findIndex((record) => {
      const event = record.type === "runtime_event" ? (record.payload as Record<string, unknown>) : record;
      const message = event.message as
        | {
            id?: string;
            role?: string;
            content?: unknown;
            timestamp?: number;
            details?: { _coworkInbox?: { messageId?: string } };
          }
        | undefined;
      const identity =
        message?.id ??
        (message?.role === "user"
          ? readQueuedUserTurn(message.content)?.messageId
          : message?.details?._coworkInbox?.messageId);
      return (
        event.type === "message_start" &&
        (identity === source.target.messageId ||
          (!identity &&
            message?.timestamp === Date.parse(entry.timestamp) &&
            userText({ type: "message", message: event.message } as SessionEntry) === userText(entry)))
      );
    });
    const prefixEvents = cutoff >= 0 ? events.slice(0, cutoff) : [];
    const versionId = randomUUID();
    const retrySnapshotPath =
      retrySnapshot === undefined
        ? undefined
        : join(root, taskId, "sessions", "main", `request-before-edit-${versionId}.json`);
    if (retrySnapshotPath) await writeFile(retrySnapshotPath, retrySnapshot!, { mode: 0o600, flag: "wx" });
    const groupId =
      versions?.archives.find((value) => value.currentMessageId === source.target.messageId)?.groupId ??
      source.target.messageId;
    const currentMessageId = replacementMessageId ?? source.target.messageId;
    const messageIndex = archivedMessages.findIndex(
      (message) => message.id === source.target.messageId || message.id === entry.id
    );
    const next: Versions = {
      version: 1,
      taskId,
      versionId,
      sessionFile,
      excludedRuns: [...new Set(allEvents.map((event) => String(event.runId)))],
      prefixEvents,
      archives: await externalizeArchives(root, taskId, [
        ...(versions?.archives ?? []).map((value) =>
          value.groupId === groupId ? { ...value, currentMessageId } : value
        ),
        {
          versionId: source.target.versionId,
          messageId: entry.id,
          sessionFile: sourceFile,
          replacedBy: versionId,
          retrySnapshotPath,
          messages: archivedMessages.slice(Math.max(0, messageIndex)),
          runtimeEvents: cutoff >= 0 ? events.slice(cutoff) : events,
          currentMessageId,
          groupId,
          preview: source.target.body.slice(0, 160),
          createdAt: new Date().toISOString(),
          activityCount: (cutoff >= 0 ? events.slice(cutoff) : events).length
        }
      ]),
      edits: [...(versions?.edits ?? []), { editId: request.editId, runId, prompt, target: request }]
    };
    const path = versionsPath(root, taskId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, path);
    const firstUser = branch.find((entry) => userText(entry) !== undefined);
    const goalForTask = firstUser ? undefined : prompt.slice(0, 4000);
    const prepared = {
      sessionFile,
      goalForTask,
      async rollback() {
        await rollbackMessageEditTransaction(root, taskId);
      }
    };
    try {
      await persistMainContext(
        mainContextPaths(root, taskId),
        branch,
        goalForTask ? { runtimeGoal: goalForTask } : {}
      );
    } catch (error) {
      await prepared.rollback();
      throw error;
    }
    return prepared;
  } catch (error) {
    await rollbackMessageEditTransaction(root, taskId);
    throw error;
  }
}
