import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { id, now } from "../domain/types.js";
import { atomicWrite } from "../storage/atomic-file.js";
import { withFileLock } from "../storage/file-lock.js";
import { watchFiles } from "./file-watch.js";
import { InboxStore } from "./scheduler.js";

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
  /**
   * A blocking tool never receives the agent's AbortSignal, so cancellation is
   * checked by the waiter. The files listed in `cancellationWatchPaths` are
   * watched: the waiter re-checks when one of them changes, rather than polling.
   */
  isCancelled?: () => Promise<boolean> | boolean;
  /** Durable records that change when this call is cancelled, e.g. the queue. */
  cancellationWatchPaths?: string[];
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
   * The answer arrives in a file, so waiting on it is a file watch rather than
   * a poll loop: the question file and any cancellation records are watched,
   * and the deadline is the only timer. Reading the answer as a tool result is
   * also why the message channel is not used — Pi only drains Main's guidance
   * after the current turn's tool calls return, so a tool waiting for it would
   * wait for itself.
   */
  async waitForAnswer(
    taskId: string,
    questionId: string,
    options: WaitForAnswerOptions
  ): Promise<WaitForAnswerResult> {
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
    const settle = async (): Promise<WaitForAnswerResult | undefined> => {
      const question = await this.read(taskId, questionId);
      if (question.status === "answered") return { status: "answered", question };
      if (question.status === "expired") return { status: "expired", question };
      if (await options.isCancelled?.()) return close("cancelled");
      if (Date.now() >= deadline) return close("expired");
      return undefined;
    };

    let version = 0;
    let waiting: (() => void) | undefined;
    const markChanged = () => {
      version += 1;
      const resolve = waiting;
      waiting = undefined;
      resolve?.();
    };
    // A watch that cannot be attached rejects here: the tool reports it
    // instead of silently waiting out a deadline nothing could shorten.
    const stopWatching = await watchFiles(
      [this.path(taskId, questionId), ...(options.cancellationWatchPaths ?? [])],
      markChanged,
      { debounceMs: 20 }
    );
    try {
      for (;;) {
        const observed = version;
        // The first pass is the read that follows attach: a write that raced
        // the OS watch registration is seen here, and later writes reach this
        // loop as change events.
        const settled = await settle();
        if (settled) return settled;
        if (version !== observed) continue;
        const remaining = deadline - Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, remaining));
        });
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              // Arm the wake before re-checking the version: a change between
              // the settlement read and this point must still end the wait.
              waiting = resolve;
              if (version !== observed) resolve();
            }),
            timeout
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          waiting = undefined;
        }
      }
    } finally {
      stopWatching();
    }
  }

  private directory(taskId: string): string {
    return join(this.workspaceRoot, taskId, "subagent-questions");
  }

  private path(taskId: string, questionId: string): string {
    return join(this.directory(safe(taskId)), `${safe(questionId)}.json`);
  }
}

export interface AskMainInput {
  workspaceRoot: string;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  agentName: string;
  question: string;
  assumption: string;
  timeoutMs: number;
  /** The per-attempt question budget and how many this attempt already used. */
  maxQuestions: number;
  asked: number;
  isCancelled?: () => Promise<boolean> | boolean;
  cancellationWatchPaths?: string[];
  /** Run once the question and its notification to Main are durable. */
  onRaised?: (question: SubagentQuestion) => Promise<void> | void;
  /** Run when the wait settles, before the caller maps the outcome. */
  onSettled?: (
    status: "answered" | "expired" | "cancelled",
    question: SubagentQuestion
  ) => Promise<void> | void;
}

export type AskMainOutcome =
  | { status: "refused"; reason: string; instruction: string }
  | { status: "answered"; question: SubagentQuestion }
  | { status: "expired"; question: SubagentQuestion }
  | { status: "cancelled"; question: SubagentQuestion };

/**
 * Raise one Subagent question and wait for Main's answer.
 *
 * The flow is one implementation because both execution paths must behave
 * identically: the same budget wording, the same durable question record, the
 * same high-priority notification in Main's Inbox, the same bounded wait, and
 * the same fallback to the declared assumption. The two callers only map the
 * outcome to their own tool result shape.
 */
export async function askMain(input: AskMainInput): Promise<AskMainOutcome> {
  const question = input.question.trim();
  const assumption = input.assumption.trim();
  if (!question) throw new Error("ask_main requires question");
  if (!assumption)
    throw new Error("ask_main requires the assumption you will follow if the question goes unanswered");
  if (input.asked >= input.maxQuestions) {
    return {
      status: "refused",
      reason: `this attempt has already used its ${input.maxQuestions} question(s)`,
      instruction: "Decide for yourself, state the assumption you made in your final summary, and continue."
    };
  }
  const store = new SubagentQuestionStore(input.workspaceRoot);
  // Unique per question rather than derived from the attempt: a retried
  // dispatch must be able to ask again, and a stale question from an
  // interrupted attempt is closed at the call's terminal boundary.
  const questionId = id("question");
  const record = await store.create({
    questionId,
    taskId: input.taskId,
    runId: input.runId,
    callId: input.callId,
    agentId: input.agentId,
    agentName: input.agentName,
    question,
    assumption
  });
  // Main reads its own durable Inbox; the question outranks an ordinary result
  // because a blocked collaborator loses its whole remaining wait.
  await new InboxStore(
    join(input.workspaceRoot, input.taskId, "runs", input.runId, "agents", "main", "inbox-store.json")
  ).enqueue({
    messageId: `subagent-question-${questionId}`,
    recipientAgentId: "main",
    kind: "subagent_question",
    callId: input.callId,
    eventId: id("event"),
    priority: 50,
    state: "ready",
    payload: {
      type: "subagent.question",
      questionId,
      callId: input.callId,
      agentId: input.agentId,
      name: input.agentName,
      question,
      assumption,
      timeoutMs: input.timeoutMs,
      instruction: `Answer with send_subagent_message({ callId: "${input.callId}", questionId: "${questionId}", message: "<your answer>" }). ${input.agentName} is blocked until you answer or the wait expires.`
    },
    createdAt: now()
  });
  await input.onRaised?.(record);
  const settled = await store.waitForAnswer(input.taskId, questionId, {
    timeoutMs: input.timeoutMs,
    ...(input.isCancelled ? { isCancelled: input.isCancelled } : {}),
    ...(input.cancellationWatchPaths ? { cancellationWatchPaths: input.cancellationWatchPaths } : {})
  });
  await input.onSettled?.(settled.status, settled.question);
  return settled;
}

function safe(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`unsafe subagent question segment: ${value}`);
  return value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
