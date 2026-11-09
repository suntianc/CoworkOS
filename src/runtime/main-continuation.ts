import { readQueuedUserTurn } from "./queued-user-turn.js";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PiThinkingLevel } from "./runtime-settings.js";

export const MAIN_CONTINUATION_COMMAND = "/atria-internal-continue";
export const MAIN_CONTINUATION_TYPE = "atria-main-continuation";

export function isMainContinuationMessage(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    "customType" in message &&
    message.customType === MAIN_CONTINUATION_TYPE
  );
}

export interface MainInput {
  version: 1;
  prompt: string;
  submittedAt: number;
  /** Raw composer body, before attachment manifests and attachment-only fallback. */
  body?: string;
  attachmentIds?: string[];
  textAttachments?: Array<{ name: string; text: string; size: number }>;
  messageId?: string;
  taskId?: string;
  runId?: string;
  /** Optional per-request reasoning override; omitted means the connection default. */
  thinkingLevel?: PiThinkingLevel;
  source?: "composer" | "human" | "inbox";
}

export function mainInputPath(workspaceRoot: string, taskId: string, runId: string): string {
  return join(workspaceRoot, taskId, "runs", runId, "main-input.json");
}

export async function readMainInput(path: string): Promise<MainInput | undefined> {
  try {
    const input = JSON.parse(await readFile(path, "utf8")) as Partial<MainInput>;
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 文件内容可能是 JSON null，解析结果并非一定是对象
      !input ||
      input.version !== 1 ||
      typeof input.prompt !== "string" ||
      !Number.isFinite(input.submittedAt)
    )
      throw new Error("原始请求无法恢复，已保存的记录仍保留。");
    return input as MainInput;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof SyntaxError) throw new Error("原始请求无法恢复，已保存的记录仍保留。");
    throw error;
  }
}

/** Save accepted input before spawning Pi, including a launch that never reaches its first hook. */
export async function saveMainInput(path: string, input: MainInput): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(input)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function mainInputDelivered(branch: readonly SessionEntry[], input: MainInput): boolean {
  return branch.some((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return false;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    const identity = readQueuedUserTurn(text);
    return (
      (identity?.text ?? text) === input.prompt &&
      entry.message.timestamp >= input.submittedAt &&
      (!input.messageId || identity?.messageId === input.messageId)
    );
  });
}

/** Use Pi's full turn lifecycle while keeping the continuation control out of model input. */
export function registerMainContinuation(
  pi: ExtensionAPI,
  prepare: (ctx: ExtensionCommandContext) => Promise<void>
): void {
  pi.registerCommand(MAIN_CONTINUATION_COMMAND.slice(1), {
    description: "Continue the saved Main turn without submitting a new user message",
    handler: async (_args, ctx) => {
      if (
        !ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              (entry.type === "message" && entry.message.role !== "system") ||
              entry.type === "compaction" ||
              entry.type === "branch_summary"
          )
      )
        throw new Error("没有可继续的请求，请先发送消息。");
      await prepare(ctx);
      pi.sendMessage(
        { customType: MAIN_CONTINUATION_TYPE, content: [], display: false },
        { triggerTurn: true }
      );
      await ctx.waitForIdle();
    }
  });
}
