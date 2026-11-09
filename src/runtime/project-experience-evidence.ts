import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  projectExperienceIdentitySchema,
  type ProjectExperienceIdentity
} from "../domain/project-experience.js";
import { projectExperienceIdentity } from "./project-experience-store.js";
import { writeMemoryJson } from "./user-memory-foreground.js";

export interface ProjectExperienceRunReference {
  identity: ProjectExperienceIdentity;
  workspaceRoot: string;
  taskId: string;
  runId: string;
}

export interface ProjectExperienceEvidenceSource {
  source: string;
  role: "user" | "assistant" | "tool" | "summary";
  text: string;
  /** Host-observed successful validation tool result, not a model's success claim. */
  validation: boolean;
}

export interface ProjectExperienceEvidence {
  taskId: string;
  runId: string;
  status: "completed" | "failed";
  sources: ProjectExperienceEvidenceSource[];
}

const segment = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read only a fixed window. Huge JSON objects are skipped rather than parsed in full. */
async function boundedRead(root: string, path: string, limit: number, tail = false): Promise<string> {
  try {
    const actual = await realpath(path);
    const within = relative(root, actual);
    if (!within || within.startsWith(`..${sep}`) || within === ".." || isAbsolute(within)) return "";
    if ((await lstat(path)).isSymbolicLink()) return "";
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || (!tail && info.size > limit)) return "";
      const offset = tail ? Math.max(0, info.size - limit) : 0;
      const buffer = Buffer.alloc(Math.min(info.size, limit));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return tail && offset > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await file.close();
    }
    // eslint-disable-next-line no-restricted-syntax -- 工作区文件可能不存在，或在校验与读取之间被替换/删除，读不到用空文本表达缺失，取证继续
  } catch {
    return "";
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
    // eslint-disable-next-line no-restricted-syntax -- 日志与回执行可能被截断成半行，解析失败按“没有该记录”处理，不让整次取证失败
  } catch {
    return undefined;
  }
}

/** Drop secret-bearing lines and attachment payloads before anything reaches a learner. */
export function projectExperienceText(value: string): string {
  return value
    .replace(/<atria_uploaded_files>[\s\S]*?<\/atria_uploaded_files>/gi, "")
    .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/g, "[attachment omitted]")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.length <= 2000 &&
        !/\b(?:api[_-]?key|authorization|access[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i.test(
          line
        )
    )
    .join("\n")
    .trim();
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value.length <= 16_000 ? value : "";
  if (!Array.isArray(value)) return "";
  return value
    .slice(0, 8)
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" && item.text.length <= 16_000
        ? [item.text]
        : [];
    })
    .join("\n");
}

function validationCommand(command: string): boolean {
  // Recognize a direct executable, never a check's name embedded in echo,
  // printf, shell substitution, a pipeline, or an arbitrary shell program.
  if (!command.trim() || command.length > 2000 || /[\r\n`$\\]/.test(command)) return false;
  const parts = command.trim().split(/\s*&&\s*/);
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^cd\s+(?:"[^"]+"|'[^']+'|[A-Za-z0-9_./:@%+=,-]+)$/.test(parts[0])) return false;
  const invocation = parts.at(-1)!;
  if (/[;|&<>]/.test(invocation)) return false;
  const tokens = invocation.match(/"[^"]*"|'[^']*'|[^\s"']+/g);
  if (!tokens || tokens.join(" ") !== invocation.replace(/\s+/g, " ")) return false;
  const args = tokens.map((token) => (/^['"]/.test(token) ? token.slice(1, -1) : token));
  const executable = basename(args.shift()!);
  if (/^(?:npm|pnpm|yarn|bun)$/.test(executable)) {
    if (args[0] === "run") args.shift();
    return /^(?:test|check|lint|verify|validate)(?::[\w-]+)?$/.test(args[0] ?? "");
  }
  if (/^(?:cargo|go)$/.test(executable)) return args[0] === "test";
  if (executable === "node" && args[0] === "--test") return true;
  if (/^(?:python|python3)$/.test(executable) && args[0] === "-m")
    return /^(?:pytest|unittest|ruff|mypy)$/.test(args[1] ?? "");
  if (/^(?:pytest|ruff|mypy|eslint|tsc)$/.test(executable)) return true;
  if (executable === "playwright") return args[0] === "test";
  const script = /^(?:validate|verify|check)(?:[_-][\w.-]+)?\.(?:py|m?js|sh)$/;
  if (/^(?:node|python|python3|bash|sh)$/.test(executable)) return script.test(basename(args[0] ?? ""));
  return script.test(executable);
}

function messageSources(
  messages: readonly unknown[],
  source: string,
  calls = new Map<string, { name: string; command: string }>()
): ProjectExperienceEvidenceSource[] {
  const result: ProjectExperienceEvidenceSource[] = [];
  for (const raw of messages.slice(-100)) {
    const message = record(raw);
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const rawPart of message.content.slice(0, 20)) {
        const part = record(rawPart);
        if (part?.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string")
          continue;
        const args = record(part.arguments);
        calls.set(part.id, {
          name: part.name.slice(0, 100),
          command: typeof args?.command === "string" && args.command.length <= 2000 ? args.command : ""
        });
        if (calls.size > 50) calls.delete(calls.keys().next().value!);
      }
    }
    const rawText = textContent(message.content);
    const text = projectExperienceText(
      message.role === "user" ? rawText.split("\n\nAttached files:\n")[0] : rawText
    ).slice(-1500);
    if (!text) continue;
    if (message.role === "user" || message.role === "assistant") {
      result.push({ source, role: message.role, text, validation: false });
    } else if (message.role === "toolResult") {
      const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
      const details = record(message.details);
      const successful =
        message.isError === false &&
        (details?.exitCode === undefined || details.exitCode === 0) &&
        !/command (?:failed|exited with (?:code )?[1-9])|\b(?:FAIL|FAILED)\b/.test(text);
      const validation = Boolean(
        call &&
        successful &&
        ((call.name === "bash" && validationCommand(call.command)) ||
          (/^(?:validate|verify)[_-]/.test(call.name) && details?.valid === true))
      );
      result.push({
        source,
        role: "tool",
        text: projectExperienceText(
          `${call?.name ?? String(message.toolName ?? "tool")} ${call?.command ?? ""}\n${text}`
        ).slice(0, 3500),
        validation
      });
    }
  }
  return result;
}

function boundedSources(sources: ProjectExperienceEvidenceSource[]): ProjectExperienceEvidenceSource[] {
  const sorted = sources.slice(-50).sort((a, b) => Number(b.validation) - Number(a.validation));
  let remaining = 12_000;
  return sorted.flatMap((source) => {
    const text = source.text.slice(0, remaining);
    remaining -= text.length;
    return text ? [{ ...source, text }] : [];
  });
}

const receiptSchema = z
  .object({
    version: z.literal(1),
    identity: projectExperienceIdentitySchema,
    taskId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    status: z.enum(["completed", "failed"]),
    sources: z
      .array(
        z
          .object({
            source: z.literal("run/host-receipt"),
            role: z.enum(["user", "assistant", "tool", "summary"]),
            text: z.string().min(1).max(3500),
            validation: z.boolean()
          })
          .strict()
      )
      .max(50)
  })
  .strict()
  .refine((value) => value.sources.reduce((sum, source) => sum + source.text.length, 0) <= 12_000);

/** Captures current-turn receipts for standalone Pi without scanning its transcript. */
export function createProjectExperienceEvidenceRecorder(reference: ProjectExperienceRunReference) {
  if (!segment(reference.taskId) || !segment(reference.runId) || !isAbsolute(reference.workspaceRoot))
    throw new Error("Invalid project experience Run reference");
  const calls = new Map<string, { name: string; command: string }>();
  let sources: ProjectExperienceEvidenceSource[] = [];
  return {
    record(messages: readonly unknown[]) {
      sources = boundedSources([...sources, ...messageSources(messages, "run/host-receipt", calls)]);
    },
    async finish(status: "completed" | "failed") {
      const receipt = receiptSchema.parse({
        version: 1,
        identity: reference.identity,
        taskId: reference.taskId,
        runId: reference.runId,
        status,
        sources
      });
      await writeMemoryJson(
        join(reference.workspaceRoot, reference.taskId, "runs", reference.runId, "experience-evidence.json"),
        receipt
      );
    }
  };
}

/** Re-read persisted ownership and terminal Run evidence; never trust a queued success flag. */
export async function readProjectExperienceEvidence(
  reference: ProjectExperienceRunReference
): Promise<ProjectExperienceEvidence | undefined> {
  if (!segment(reference.taskId) || !segment(reference.runId) || !isAbsolute(reference.workspaceRoot))
    return undefined;
  let root: string;
  try {
    root = await realpath(join(reference.workspaceRoot, reference.taskId));
    const workspace = await realpath(reference.workspaceRoot);
    if (relative(workspace, root) !== reference.taskId) return undefined;
    // eslint-disable-next-line no-restricted-syntax -- Task 目录可能已被清理或不属于当前工作区，realpath 失败即视为没有可读证据
  } catch {
    return undefined;
  }
  const runRoot = join(root, "runs", reference.runId);
  const task = record(json(await boundedRead(root, join(root, "task.json"), 64 * 1024)));
  const run = record(json(await boundedRead(root, join(runRoot, "run.json"), 8192)));
  let taskIdentity: ReturnType<typeof projectExperienceIdentity>;
  try {
    taskIdentity = projectExperienceIdentity({
      projectId: typeof task?.projectId === "string" ? task.projectId : undefined,
      projectDirectory: typeof task?.projectDirectory === "string" ? task.projectDirectory : undefined,
      projectCatalogPath: typeof task?.projectCatalogPath === "string" ? task.projectCatalogPath : undefined
    });
    // eslint-disable-next-line no-restricted-syntax -- task.json 可能缺少项目字段或来自其它版本，身份算不出来时该 Run 不产生经验
  } catch {
    return undefined;
  }
  const directoryMatches =
    typeof task?.projectDirectory === "string" &&
    (resolve(task.projectDirectory) === resolve(reference.identity.projectDirectory) ||
      // eslint-disable-next-line no-restricted-syntax -- 任务的项目目录可能已不存在，空串在下方比较中恒不相等，等价于目录不匹配
      (await realpath(task.projectDirectory).catch(() => "")) ===
        // eslint-disable-next-line no-restricted-syntax -- 参考身份的项目目录可能已不存在，"missing" 是哨兵值，不会与真实路径相等
        (await realpath(reference.identity.projectDirectory).catch(() => "missing")));
  if (
    task?.taskId !== reference.taskId ||
    run?.taskId !== reference.taskId ||
    run.runId !== reference.runId ||
    task.temporaryWorkspaceRoot ||
    task.kind === "workspace" ||
    taskIdentity?.projectId !== reference.identity.projectId ||
    !directoryMatches ||
    taskIdentity.projectCatalogPath !== reference.identity.projectCatalogPath
  )
    return undefined;

  const ledger = (await boundedRead(root, join(runRoot, "run_events.jsonl"), 64 * 1024, true))
    .split(/\r?\n/)
    .map((line) => record(json(line)))
    .filter((event) => event?.taskId === reference.taskId && event.runId === reference.runId);
  const terminal = ledger
    .reverse()
    .find((event) => /^(?:main\.run_|run\.)(?:completed|failed)$/.test(String(event?.type)));
  const result = record(
    json(await boundedRead(root, join(runRoot, "agents", "main", "result.json"), 128 * 1024))
  );
  const saved = receiptSchema.safeParse(
    json(await boundedRead(root, join(runRoot, "experience-evidence.json"), 64 * 1024))
  );
  const receipt =
    saved.success &&
    saved.data.taskId === reference.taskId &&
    saved.data.runId === reference.runId &&
    saved.data.identity.projectId === reference.identity.projectId &&
    saved.data.identity.projectCatalogPath === reference.identity.projectCatalogPath
      ? saved.data
      : undefined;
  const status = terminal
    ? String(terminal.type).endsWith("completed")
      ? "completed"
      : "failed"
    : result?.termination === "completed" || result?.termination === "failed"
      ? result.termination
      : receipt?.status;
  if (!status) return undefined;

  let sources: ProjectExperienceEvidenceSource[] = receipt?.sources ?? [];
  const runtime = await boundedRead(root, join(runRoot, "runtime-output.log"), 128 * 1024, true);
  const messages = runtime.split(/\r?\n/).flatMap((line) => {
    const event = record(json(line));
    return event?.type === "message_end" && record(event.message) ? [event.message] : [];
  });
  if (!sources.length && messages.length) sources = messageSources(messages, "run/runtime-output");
  else if (!sources.length && Array.isArray(result?.messages))
    sources = messageSources(result.messages, "run/result");
  else if (!sources.length) {
    const checkpoint = record(json(await boundedRead(root, join(runRoot, "checkpoint.json"), 128 * 1024)));
    const state = record(checkpoint?.state);
    if (checkpoint?.runId === reference.runId && Array.isArray(state?.messages))
      sources = messageSources(state.messages, "run/checkpoint");
  }
  const summary =
    task.activeRunId === reference.runId
      ? projectExperienceText(
          await boundedRead(root, join(root, "agents", "main", "context", "memory.md"), 8000, true)
        )
      : "";
  if (summary) sources.push({ source: "task/memory.md", role: "summary", text: summary, validation: false });
  sources = boundedSources(sources);
  return sources.length ? { taskId: reference.taskId, runId: reference.runId, status, sources } : undefined;
}
