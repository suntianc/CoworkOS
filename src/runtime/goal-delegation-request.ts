import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { mainInputPath, readMainInput, type MainInput } from "./main-continuation.js";
import { readQueuedUserTurn } from "./queued-user-turn.js";
import { SUPERVISOR_WAKE_TURN } from "./main-supervisor.js";

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
const requestIdentity = z.string().min(1).max(512);
const requestState = z.object({
  version: z.literal(1),
  requestId: requestIdentity.optional(),
  legacyRequestId: requestIdentity.optional()
});
const statePath = (root: string, taskId: string, runId: string) =>
  join(root, identity.parse(taskId), "runs", identity.parse(runId), "goal-delegation-request.json");

export async function readGoalDelegationRequest(root: string, taskId: string, runId: string) {
  try {
    return requestState.parse(JSON.parse(await readFile(statePath(root, taskId, runId), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function saveRequestState(
  root: string,
  taskId: string,
  runId: string,
  value: z.infer<typeof requestState>
) {
  const path = statePath(root, taskId, runId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(requestState.parse(value)), { mode: 0o600 });
  await rename(temporary, path);
}

/** Undefined is an archived request without a known boundary: fail closed until fresh context. */
export async function restoreGoalDelegationRequest(
  root: string,
  taskId: string,
  runId: string,
  requestId: string | undefined,
  replay?: { branch: readonly SessionEntry[]; messages: readonly unknown[] }
): Promise<void> {
  const previous = await readGoalDelegationRequest(root, taskId, runId);
  const restored =
    requestId === undefined && replay
      ? {
          taskId,
          runId,
          branch: replay.branch,
          mainInput: await readMainInput(mainInputPath(root, taskId, runId))
        }
      : undefined;
  const legacyRequestId =
    (restored && goalDelegationRequestId({ ...restored, messages: replay!.messages })) ??
    previous?.legacyRequestId ??
    requestId ??
    (restored && goalDelegationRequestId(restored));
  const value = requestState.parse({ ...previous, version: 1, requestId, legacyRequestId });
  await saveRequestState(root, taskId, runId, value);
}

type Message = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  customType?: string;
  details?: { _coworkInbox?: { taskId?: string; runId?: string; messageId?: string } };
};
function text(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
    : "";
}
function messageKey(message: Message): string | undefined {
  if (message.role === "user")
    return JSON.stringify([
      "user",
      message.timestamp,
      readQueuedUserTurn(message.content)?.text ?? text(message.content),
      Array.isArray(message.content) ? message.content.filter((part) => part?.type !== "text") : []
    ]);
  if (message.customType === "cowork-user-message")
    return JSON.stringify(["inbox", message.details?._coworkInbox]);
}

/** Only delivered user entries advance ownership; queued inputs and background events do not. */
export function goalDelegationRequestId(input: {
  taskId: string;
  runId: string;
  sessionId?: string;
  branch: readonly SessionEntry[];
  messages?: readonly unknown[];
  mainInput?: MainInput;
}): string | undefined {
  const visible = input.messages
    ? new Set(input.messages.map((message) => messageKey(message as Message)).filter(Boolean))
    : undefined;
  let latest: string | undefined;
  let submittedMatched = false;
  for (const entry of input.branch) {
    const message =
      entry.type === "message" ? entry.message : entry.type === "custom_message" ? entry : undefined;
    if (!message) continue;
    const delivered =
      !visible ||
      visible.has(messageKey(message as Message)) ||
      (entry.type === "custom_message" &&
        visible.has(
          messageKey({
            role: "user",
            content: entry.content,
            timestamp: Date.parse(entry.timestamp)
          })
        ));
    if (entry.type === "custom_message" && entry.customType === "cowork-user-message") {
      const inbox = (entry.details as Message["details"])?._coworkInbox;
      if (inbox?.messageId === input.mainInput?.messageId) submittedMatched = true;
      if (delivered && inbox?.taskId === input.taskId && inbox.runId === input.runId && inbox.messageId)
        latest = `user:${inbox.messageId}`;
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = text(entry.message.content);
    const queued = readQueuedUserTurn(content);
    const submitted = input.mainInput;
    const isSubmitted =
      !submittedMatched &&
      submitted &&
      content === submitted.prompt &&
      entry.message.timestamp >= submitted.submittedAt;
    if (isSubmitted || (queued && queued.messageId === submitted?.messageId)) submittedMatched = true;
    if (!delivered || content === SUPERVISOR_WAKE_TURN) continue;
    if (queued?.taskId === input.taskId && queued.runId === input.runId) {
      latest = `user:${queued.messageId}`;
      continue;
    }
    if (isSubmitted) {
      if (submitted.source === "human") continue;
      if (submitted.messageId) {
        latest = `user:${submitted.messageId}`;
        continue;
      }
    }
    // Project/session forks copy entry IDs and timestamps, preserving the accepted request.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 条目来自 Pi 的 session JSONL，扩展写入的 custom_message 条目可能没有 entry 级 timestamp
    latest = `pi:${entry.id}:${entry.timestamp ?? entry.message.timestamp}`;
  }
  return latest;
}

export async function syncGoalDelegationRequest(
  root: string,
  taskId: string,
  runId: string,
  input: {
    sessionId: string;
    branch: readonly SessionEntry[];
    messages?: readonly unknown[];
    initializeOnly?: boolean;
  }
): Promise<void> {
  const previous = await readGoalDelegationRequest(root, taskId, runId);
  if (input.initializeOnly && previous) return;
  const requestId = goalDelegationRequestId({
    ...input,
    taskId,
    runId,
    mainInput: await readMainInput(mainInputPath(root, taskId, runId))
  });
  if (!requestId || requestId === previous?.requestId) return;
  const legacyRequestId = previous?.legacyRequestId ?? requestId;
  await saveRequestState(root, taskId, runId, { version: 1, requestId, legacyRequestId });
}
