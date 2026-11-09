import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { id, now, type InboxMessage } from "../domain/types.js";
import { withFileLock } from "../storage/file-lock.js";
import { InboxStore } from "./scheduler.js";

/**
 * `unanswered` is a question the model stopped waiting for.
 *
 * It is distinct from `pending`, which means someone is still blocked on it, and
 * from `cancelled`, which means it no longer matters. The model has moved on
 * using its recommended option, but the person may still answer — so the UI
 * keeps offering it, and an answer still reaches Main through the durable path.
 * The completion gate treats only `pending` as outstanding work: leaving a
 * timed-out question pending meant the turn could never finish.
 */
export type HumanRequestStatus = "pending" | "answered" | "cancelled" | "unanswered";

export interface HumanRequest {
  requestId: string;
  taskId: string;
  runId: string;
  question: string;
  context?: string;
  options?: string[];
  /**
   * Zero-based index into `options`: the choice the model would make itself.
   *
   * It is what the model proceeds on when nobody answers in time, so it is a
   * commitment rather than a hint — and showing it lets the person accept the
   * obvious answer without reading every option.
   */
  recommended?: number;
  status: HumanRequestStatus;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
  /** Records the replacement Run and the unresolved state to restore on edit rollback. */
  superseded?: { runId: string; status: "pending" | "unanswered" };
}

/**
 * Durable, deliberately small human-in-the-loop store. A request is a file so
 * a CLI, UI or another process can answer it without keeping the Main model
 * process alive. The answer is delivered through the ordinary Main Inbox by
 * the caller that owns the run.
 */
export class HumanRequestStore {
  constructor(private readonly workspaceRoot: string) {}

  async create(
    input: Pick<HumanRequest, "taskId" | "runId" | "question" | "context" | "options" | "recommended">,
    requestId?: string
  ): Promise<HumanRequest> {
    const choices = input.options
      ?.map((option, index) => ({ text: option.trim(), index }))
      .filter((option) => option.text);
    const recommended = Number.isInteger(input.recommended)
      ? choices?.findIndex((option) => option.index === input.recommended)
      : undefined;
    const request: HumanRequest = {
      requestId: requestId ? safe(requestId) : id("human"),
      taskId: safe(input.taskId),
      runId: safe(input.runId),
      question: input.question.trim(),
      context: input.context?.trim() || undefined,
      options: choices?.map((option) => option.text),
      // Kept only when it points at a real option, so the UI and the timeout
      // path never have to guard against an index that is not there.
      ...(recommended !== undefined && recommended >= 0 ? { recommended } : {}),
      status: "pending",
      createdAt: now()
    };
    if (!request.question) throw new Error("human question must not be empty");
    const path = this.path(request.taskId, request.requestId);
    await mkdir(join(this.workspaceRoot, request.taskId, "human", "requests"), { recursive: true });
    try {
      await writeFile(path, json(request), { flag: "wx" });
      return request;
    } catch (error) {
      if (!requestId || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(input.taskId, requestId);
      if (existing.question !== request.question || existing.runId !== request.runId)
        throw new Error("human request identity conflict");
      return existing;
    }
  }

  async read(taskId: string, requestId: string): Promise<HumanRequest> {
    return JSON.parse(await readFile(this.path(taskId, requestId), "utf8")) as HumanRequest;
  }

  async list(taskId: string, status?: HumanRequestStatus): Promise<HumanRequest[]> {
    const directory = join(this.workspaceRoot, safe(taskId), "human", "requests");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const requests: HumanRequest[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const request = await this.read(taskId, entry.name.slice(0, -5));
        if (!status || request.status === status) requests.push(request);
        // eslint-disable-next-line no-restricted-syntax -- 列表扫描是 best-effort：请求文件可能被并发删除或写到一半，跳过它但保留其余请求
      } catch {
        /* ignore an incomplete temporary file */
      }
    }
    return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async answer(taskId: string, requestId: string, answer: string): Promise<HumanRequest> {
    const path = this.path(taskId, requestId);
    return withFileLock(path, async () => {
      const request = await this.read(taskId, requestId);
      if (request.status === "answered") return request;
      if (request.status === "cancelled") throw new Error(`human request is cancelled: ${requestId}`);
      // `unanswered` is answerable: the model gave up waiting, the person did
      // not give up deciding.
      const next: HumanRequest = { ...request, status: "answered", answer: answer.trim(), answeredAt: now() };
      if (!next.answer) throw new Error("human answer must not be empty");
      await atomicWrite(path, json(next));
      return next;
    });
  }

  /**
   * Block until the person answers, or the deadline passes.
   *
   * This is what makes `askhuman` an ordinary asynchronous tool: the answer
   * comes back as its tool result, so the transcript records a tool call and
   * its result instead of a fabricated user turn. It polls a file for the same
   * reason `SubagentQuestionStore.waitForAnswer` does — the answer arrives in
   * another process (the Dashboard), and nothing signals this one.
   *
   * The wait is deliberately short. A person may take days, and holding a Main
   * process and its context open for that is not viable, so a timeout is not a
   * failure: it hands the decision back to the model, which proceeds on the
   * recommended option and says so.
   */
  async waitForAnswer(
    taskId: string,
    requestId: string,
    options: { timeoutMs: number; pollMs?: number; isCancelled?: () => Promise<boolean> }
  ): Promise<{ status: "answered" | "timeout" | "cancelled"; request: HumanRequest }> {
    const pollMs = Math.max(50, options.pollMs ?? 250);
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    for (;;) {
      const request = await this.read(taskId, requestId);
      if (request.status === "answered") return { status: "answered", request };
      if (request.status === "cancelled") return { status: "cancelled", request };
      if (await options.isCancelled?.()) {
        const settled = await this.cancel(taskId, requestId);
        return settled.status === "answered"
          ? { status: "answered", request: settled }
          : { status: "cancelled", request: settled };
      }
      const remaining = deadline - Date.now();
      // Re-read once more before giving up: an answer landing inside the final
      // interval is a real answer, and reporting a timeout would discard it.
      if (remaining <= 0) {
        const settled = await this.read(taskId, requestId);
        return settled.status === "answered"
          ? { status: "answered", request: settled }
          : { status: settled.status === "cancelled" ? "cancelled" : "timeout", request: settled };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
  }

  /**
   * Record that the model stopped waiting, without closing the question.
   *
   * A person answering late is still answering: `answer` accepts an unanswered
   * request exactly as it accepts a pending one.
   */
  async markUnanswered(taskId: string, requestId: string): Promise<HumanRequest> {
    const path = this.path(taskId, requestId);
    return withFileLock(path, async () => {
      const request = await this.read(taskId, requestId);
      if (request.status !== "pending") return request;
      const next: HumanRequest = { ...request, status: "unanswered" };
      await atomicWrite(path, json(next));
      return next;
    });
  }

  async cancel(taskId: string, requestId: string): Promise<HumanRequest> {
    const path = this.path(taskId, requestId);
    return withFileLock(path, async () => {
      const request = await this.read(taskId, requestId);
      if (request.status !== "pending") return request;
      const next: HumanRequest = { ...request, status: "cancelled" };
      await atomicWrite(path, json(next));
      return next;
    });
  }

  /** Questions in a replaced message's tail cannot accept decisions for the new branch. */
  async supersede(taskId: string, requestId: string, runId: string): Promise<void> {
    const path = this.path(taskId, requestId);
    await withFileLock(path, async () => {
      const request = await this.read(taskId, requestId);
      if (request.status !== "pending" && request.status !== "unanswered") return;
      await atomicWrite(
        path,
        json({ ...request, status: "cancelled", superseded: { runId, status: request.status } })
      );
    });
  }

  /** A rejected pre-spawn edit restores only questions retired by that edit. */
  async restoreSuperseded(taskId: string, requestId: string, runId: string): Promise<void> {
    const path = this.path(taskId, requestId);
    await withFileLock(path, async () => {
      const request = await this.read(taskId, requestId);
      if (request.status !== "cancelled" || request.superseded?.runId !== runId) return;
      const { superseded, ...original } = request;
      await atomicWrite(path, json({ ...original, status: superseded.status }));
    });
  }

  /** A retry after a lost HTTP response keeps the first answer and repairs a
   * missing Inbox write; enqueue never replaces an already consumed answer. */
  async submitAnswer(taskId: string, requestId: string, answer: string) {
    if (!answer.trim()) throw new Error("human answer must not be empty");
    const request = await this.answer(taskId, requestId, answer);
    // enqueue never replaces the consumed receipt a waiting tool may have
    // written between recording the answer and queuing this recovery copy.
    const message = await this.answerInbox(request).enqueue(answerMessage(request));
    return { request, message };
  }

  /**
   * Mark the durable copy of an answer as already delivered.
   *
   * An answer is written in two places on purpose: the request file, which a
   * blocked `askhuman` reads, and the Inbox, which is what reaches Main after a
   * restart. When the waiting tool got the answer itself, the Inbox copy is a
   * duplicate — left queued, it arrived as a second, unprompted instruction in
   * the next turn, telling Main to act on a decision it had already acted on.
   *
   * Consuming a message that was never queued, or was consumed already, is not
   * an error: both mean the same thing here.
   */
  async consumeAnswerMessage(taskId: string, requestId: string): Promise<void> {
    const request = await this.read(taskId, requestId);
    if (request.status !== "answered") return;
    const inbox = this.answerInbox(request);
    // A disk-only answer or failed Inbox write can reach the tool first.
    // Persist an already-consumed copy so a later submission repair cannot
    // turn the same accepted decision back into a new instruction.
    const queued = await inbox.enqueue(answerMessage(request, "consumed"));
    if (queued.state === "consumed") return;
    if (queued.state === "ready") await inbox.leaseMessage("main", queued.messageId);
    await inbox.consume(queued.messageId);
  }

  private answerInbox(request: HumanRequest): InboxStore {
    return new InboxStore(
      join(this.workspaceRoot, request.taskId, "runs", request.runId, "agents", "main", "inbox-store.json")
    );
  }

  private path(taskId: string, requestId: string): string {
    return join(this.workspaceRoot, safe(taskId), "human", "requests", `${safe(requestId)}.json`);
  }
}

function answerMessage(request: HumanRequest, state: "ready" | "consumed" = "ready"): InboxMessage {
  return {
    messageId: `human-answer-${request.requestId}`,
    recipientAgentId: "main",
    kind: "human_command",
    eventId: `human-answer-event-${request.requestId}`,
    priority: 100,
    state,
    payload: {
      type: "human.answer",
      requestId: request.requestId,
      question: request.question,
      answer: request.answer,
      context: request.context
    },
    createdAt: request.answeredAt ?? now()
  };
}

function safe(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`unsafe human request segment: ${value}`);
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
