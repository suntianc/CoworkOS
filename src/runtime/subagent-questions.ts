import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { now } from "../domain/types.js";
import { withFileLock } from "../storage/file-lock.js";

export type SubagentQuestionStatus = "pending" | "answered" | "expired";

export interface SubagentQuestion {
  questionId: string;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  agentName: string;
  question: string;
  /** What the Subagent will do if nobody answers. A timeout must leave a path forward. */
  assumption: string;
  status: SubagentQuestionStatus;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
  expiredAt?: string;
}

export interface WaitForAnswerOptions {
  timeoutMs: number;
  pollMs?: number;
  /** A blocking tool never receives the agent's AbortSignal, so cancellation is polled. */
  isCancelled?: () => Promise<boolean> | boolean;
}

export type WaitForAnswerResult =
  | { status: "answered"; question: SubagentQuestion }
  | { status: "expired"; question: SubagentQuestion }
  | { status: "cancelled"; question: SubagentQuestion };

/**
 * Durable Subagent -> Main question store, deliberately shaped like
 * HumanRequestStore: a question is one file so Main can answer it from another
 * process, and the record outlives the Run that raised it.
 *
 * A question is stored per Task rather than per Run because the answer must be
 * findable after a restart, and because completion gates read it from disk with
 * no live Main process to ask.
 */
export class SubagentQuestionStore {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Open a question. The id is caller-supplied and creation is exclusive, so a
   * tool call replayed after a crash reuses the existing record instead of
   * opening a second one for the same moment in the Subagent's transcript.
   */
  async create(
    input: Pick<
      SubagentQuestion,
      "questionId" | "taskId" | "runId" | "callId" | "agentId" | "agentName" | "question" | "assumption"
    >
  ): Promise<SubagentQuestion> {
    const question: SubagentQuestion = {
      questionId: safe(input.questionId),
      taskId: safe(input.taskId),
      runId: safe(input.runId),
      callId: input.callId,
      agentId: safe(input.agentId),
      agentName: input.agentName,
      question: input.question.trim(),
      assumption: input.assumption.trim(),
      status: "pending",
      createdAt: now()
    };
    if (!question.question) throw new Error("subagent question must not be empty");
    if (!question.assumption)
      throw new Error("subagent question requires the assumption it will follow if unanswered");
    await mkdir(this.directory(question.taskId), { recursive: true });
    try {
      await writeFile(this.path(question.taskId, question.questionId), json(question), { flag: "wx" });
      return question;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.read(question.taskId, question.questionId);
    }
  }

  async read(taskId: string, questionId: string): Promise<SubagentQuestion> {
    return JSON.parse(await readFile(this.path(taskId, questionId), "utf8")) as SubagentQuestion;
  }

  async list(taskId: string, status?: SubagentQuestionStatus): Promise<SubagentQuestion[]> {
    let entries;
    try {
      entries = await readdir(this.directory(safe(taskId)), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const questions: SubagentQuestion[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const question = await this.read(taskId, entry.name.slice(0, -5));
        if (!status || question.status === status) questions.push(question);
        // eslint-disable-next-line no-restricted-syntax -- 写到一半或损坏的问题文件读不出 JSON，跳过这条，目录中其余记录继续列出
      } catch {
        /* ignore an incomplete temporary file */
      }
    }
    return questions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Record Main's answer. A repeated answer keeps the first one. */
  async answer(taskId: string, questionId: string, answer: string): Promise<SubagentQuestion> {
    const path = this.path(taskId, questionId);
    return withFileLock(path, async () => {
      const question = await this.read(taskId, questionId);
      if (question.status === "answered") return question;
      // An answer that arrives after the Subagent gave up is not an error: the
      // caller decides how to deliver it, and this record stays expired.
      if (question.status === "expired") return question;
      const next: SubagentQuestion = {
        ...question,
        status: "answered",
        answer: answer.trim(),
        answeredAt: now()
      };
      if (!next.answer) throw new Error("subagent question answer must not be empty");
      await atomicWrite(path, json(next));
      return next;
    });
  }

  /** Close an unanswered question so it stops counting as outstanding work. */
  async expire(taskId: string, questionId: string): Promise<SubagentQuestion> {
    const path = this.path(taskId, questionId);
    return withFileLock(path, async () => {
      const question = await this.read(taskId, questionId);
      if (question.status !== "pending") return question;
      const next: SubagentQuestion = { ...question, status: "expired", expiredAt: now() };
      await atomicWrite(path, json(next));
      return next;
    });
  }

  /**
   * Close every pending question raised by one delegated call.
   *
   * A question whose Subagent is gone can never be answered, and a pending
   * question counts as outstanding work — so a terminal call that left one open
   * would keep the Task from ever completing. This runs at the same boundary
   * that settles the call.
   */
  async expireForCall(taskId: string, callId: string): Promise<SubagentQuestion[]> {
    const pending = (await this.list(taskId, "pending")).filter((question) => question.callId === callId);
    const expired: SubagentQuestion[] = [];
    for (const question of pending) {
      // eslint-disable-next-line no-restricted-syntax -- expire 写盘失败时保留原记录，未决状态由下次 list 重新判定，不能因此中断收尾
      expired.push(await this.expire(taskId, question.questionId).catch(() => question));
    }
    return expired;
  }

  /**
   * Block until Main answers, the deadline passes, or the call is cancelled.
   *
   * Polling a file is what makes this work at all: the existing Main -> Subagent
   * path injects through `agent.steer()`, whose queue is only drained after the
   * current turn's tool calls return — so a tool waiting on a steered reply
   * would wait for itself. Cancellation is polled for the same reason the reply
   * is: this tool never receives the agent's AbortSignal.
   */
  async waitForAnswer(
    taskId: string,
    questionId: string,
    options: WaitForAnswerOptions
  ): Promise<WaitForAnswerResult> {
    // A coarse interval would add its own latency to every answered question,
    // leaving the Subagent idle after Main has already decided.
    const pollMs = Math.max(50, options.pollMs ?? 250);
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    // Closing the question is also how the race with a just-arrived answer is
    // settled: `expire` leaves an answered record alone, so whatever it returns
    // is the real outcome. Asserting "expired" here instead would throw away an
    // answer Main has already been told was delivered.
    const close = async (reason: "expired" | "cancelled"): Promise<WaitForAnswerResult> => {
      const question = await this.expire(taskId, questionId);
      if (question.status === "answered") return { status: "answered", question };
      return { status: reason, question };
    };
    for (;;) {
      const question = await this.read(taskId, questionId);
      if (question.status === "answered") return { status: "answered", question };
      if (question.status === "expired") return { status: "expired", question };
      if (await options.isCancelled?.()) return close("cancelled");
      const remaining = deadline - Date.now();
      if (remaining <= 0) return close("expired");
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
  }

  private directory(taskId: string): string {
    return join(this.workspaceRoot, taskId, "subagent-questions");
  }

  private path(taskId: string, questionId: string): string {
    return join(this.directory(safe(taskId)), `${safe(questionId)}.json`);
  }
}

function safe(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`unsafe subagent question segment: ${value}`);
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
