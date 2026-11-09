import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Long commands the model supervises instead of a timer.
 *
 * A fixed deadline cannot tell a healthy job from a wedged one: a training run
 * writing a line every thirty seconds and an installer stuck on a prompt look
 * identical to a clock, so any value either kills real work or waits forever on
 * dead work. The model can tell them apart, given the evidence — how long it
 * has run, whether the log is still growing, what the last lines say.
 *
 * Jobs are recorded on disk, not only in memory. A job outliving the Agent that
 * started it is the normal case here: a three-hour training run survives a
 * context reset, a crash, and a supervisor restart, and the Agent that comes
 * back must still be able to find it, read its log and kill it. Liveness comes
 * from the pid, so a record is never mistaken for a running process.
 */

export interface JobRecord {
  jobId: string;
  command: string;
  cwd: string;
  logPath: string;
  pid?: number;
  startedAt: string;
  exitCode?: number;
  signal?: string;
  finishedAt?: string;
  /** The process never started; distinct from a command's nonzero exit code. */
  spawnError?: string;
}

export interface JobStatus {
  jobId: string;
  command: string;
  state: "running" | "exited";
  elapsedMs: number;
  exitCode?: number;
  signal?: string;
  spawnError?: string;
  logPath: string;
  logBytes: number;
  /** Milliseconds since the log last grew. Silence is evidence, not a verdict. */
  quietMs: number;
  tail: string;
  /** Set when the process is gone but no exit was recorded — a crash, or a restart. */
  note?: string;
}

export interface JobsOptions {
  /** Directory holding job records and logs. Usually the Agent's own logs/jobs. */
  directory: string;
}

export interface StartJobInput extends JobsOptions {
  command: string;
  cwd: string;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function startJob(
  input: StartJobInput
): Promise<{ jobId: string; logPath: string; pid?: number }> {
  await mkdir(input.directory, { recursive: true });
  const jobId = await nextJobId(input.directory);
  const logPath = join(input.directory, `${jobId}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const record: JobRecord = {
    jobId,
    command: input.command,
    cwd: input.cwd,
    logPath,
    startedAt: new Date().toISOString()
  };
  async function failToStart(error: Error): Promise<never> {
    log.destroy();
    const message = `Failed to start job ${jobId} in ${input.cwd}: ${error.message}`;
    // Keep the original launch error even if recording it also fails.
    await writeRecord(input.directory, {
      ...record,
      spawnError: message,
      finishedAt: new Date().toISOString()
      // eslint-disable-next-line no-restricted-syntax -- 正在上抛启动失败，记录写失败不能让原始错误丢失或被替换
    }).catch(() => {});
    throw new Error(message, { cause: error });
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.command, {
      cwd: input.cwd,
      shell: input.shell ?? true,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group, so killing the job takes the whole pipeline with it
      // rather than leaving the real work orphaned behind a dead shell.
      detached: true
    });
  } catch (error) {
    return failToStart(error instanceof Error ? error : new Error(String(error)));
  }
  // ENOENT (including a missing cwd) is an asynchronous error event, not an
  // exit code or a synchronous throw. Subscribe before any disk I/O, and do
  // not report a running job until the OS confirms that it actually spawned.
  // Resolve with the error so it cannot become an unhandled rejection while
  // the initial record is still being written.
  const started = new Promise<Error | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", resolve);
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  record.pid = child.pid;
  const recorded = writeRecord(input.directory, record);
  // Subscribe before awaiting disk I/O: a short job can exit while its initial
  // record is being written. Persist its exit after that write, in order.
  child.on("exit", (code, signal) => {
    const finished = {
      ...record,
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
      finishedAt: new Date().toISOString()
    };
    void recorded
      .then(() => writeRecord(input.directory, finished))
      // eslint-disable-next-line no-restricted-syntax -- 退出记录写失败时日志与 pid 检查仍是权威证据，不能让它变成未处理的 rejection
      .catch(() => {
        /* the log and the pid check remain authoritative */
      });
  });
  await recorded;
  const spawnError = await started;
  if (spawnError) return failToStart(spawnError);
  // The parent must be able to exit while the job keeps running; the record on
  // disk is what a later Agent uses to find it again.
  child.unref();
  return { jobId, logPath, pid: child.pid };
}

export async function jobStatus(
  input: JobsOptions & { jobId: string; tailBytes?: number }
): Promise<JobStatus> {
  const record = await readRecord(input.directory, input.jobId);
  if (!record) throw new Error(`unknown job: ${input.jobId}`);
  const tailBytes = input.tailBytes ?? 4_000;
  let logBytes = 0;
  let modifiedMs = Date.parse(record.startedAt);
  try {
    const info = await stat(record.logPath);
    logBytes = info.size;
    modifiedMs = info.mtimeMs;
    // eslint-disable-next-line no-restricted-syntax -- 任务刚启动时日志文件可能还不存在，缺失由 logBytes=0 和 tail 空串表达
  } catch {
    /* the job may not have written anything yet */
  }

  const recordedExit = record.finishedAt !== undefined;
  const alive = !recordedExit && record.pid !== undefined && pidAlive(record.pid);
  const finishedMs = record.finishedAt ? Date.parse(record.finishedAt) : undefined;
  return {
    jobId: record.jobId,
    command: record.command,
    state: alive ? "running" : "exited",
    elapsedMs: (finishedMs ?? Date.now()) - Date.parse(record.startedAt),
    exitCode: record.exitCode,
    signal: record.signal,
    ...(record.spawnError ? { spawnError: record.spawnError } : {}),
    logPath: record.logPath,
    logBytes,
    quietMs: Math.max(0, Date.now() - modifiedMs),
    tail: await readTail(record.logPath, tailBytes),
    // A process that is gone without a recorded exit ended while nothing was
    // watching. The log is still the evidence for what it did.
    ...(!alive && !recordedExit
      ? {
          note: "the process is no longer running and no exit status was recorded; it ended while unobserved — read the log to see how far it got"
        }
      : {})
  };
}

export async function listJobs(input: JobsOptions): Promise<JobStatus[]> {
  let entries: string[];
  try {
    entries = (await readdir(input.directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const statuses: JobStatus[] = [];
  for (const entry of entries.sort()) {
    try {
      statuses.push(
        await jobStatus({ directory: input.directory, jobId: entry.replace(/\.json$/, ""), tailBytes: 400 })
      );
      // eslint-disable-next-line no-restricted-syntax -- 单条记录不可读（被截断或来自其它版本）时跳过该 job，其它记录仍要列出
    } catch {
      /* skip an unreadable record */
    }
  }
  return statuses;
}

/**
 * Stop a job. SIGTERM first so it can clean up, then SIGKILL if it ignores it.
 * The negative pid targets the process group, since the thing worth killing is
 * usually a child of the shell that was started.
 */
export async function killJob(input: JobsOptions & { jobId: string; graceMs?: number }): Promise<JobStatus> {
  const record = await readRecord(input.directory, input.jobId);
  if (!record) throw new Error(`unknown job: ${input.jobId}`);
  const graceMs = input.graceMs ?? 5_000;
  if (record.finishedAt === undefined && record.pid !== undefined && pidAlive(record.pid)) {
    signalGroup(record.pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (pidAlive(record.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (pidAlive(record.pid)) signalGroup(record.pid, "SIGKILL");
    // The exit handler only fires in the process that spawned the job, so
    // record the outcome here too for an Agent that inherited it.
    const current = await readRecord(input.directory, input.jobId);
    if (current && current.finishedAt === undefined) {
      await writeRecord(input.directory, {
        ...current,
        signal: "SIGTERM",
        finishedAt: new Date().toISOString()
        // eslint-disable-next-line no-restricted-syntax -- 进程已被杀死，这里补写的退出记录失败时 jobStatus 仍会按 pid 与日志报告状态
      }).catch(() => {});
    }
  }
  return jobStatus({ directory: input.directory, jobId: input.jobId });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    // eslint-disable-next-line no-restricted-syntax -- 进程组可能已不存在（kill 抛 ESRCH），需要回退到单个 pid 再试一次
  } catch {
    try {
      process.kill(pid, signal);
      // eslint-disable-next-line no-restricted-syntax -- 进程已退出，信号无法送达属预期结果，调用方无需区分
    } catch {
      /* already gone */
    }
  }
}

async function nextJobId(directory: string): Promise<string> {
  let highest = 0;
  try {
    for (const name of await readdir(directory)) {
      const match = /^job-(\d+)\.json$/.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    // eslint-disable-next-line no-restricted-syntax -- 任务目录可能还不存在，视为还没有 job，从 job-1 开始编号
  } catch {
    /* first job in a fresh directory */
  }
  return `job-${highest + 1}`;
}

function recordPath(directory: string, jobId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(jobId)) throw new Error(`unsafe job id: ${jobId}`);
  return join(directory, `${jobId}.json`);
}

async function writeRecord(directory: string, record: JobRecord): Promise<void> {
  const path = recordPath(directory, record.jobId);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readRecord(directory: string, jobId: string): Promise<JobRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(recordPath(directory, jobId), "utf8")) as Partial<JobRecord>;
    if (
      typeof value.jobId !== "string" ||
      typeof value.command !== "string" ||
      typeof value.startedAt !== "string"
    )
      return undefined;
    return value as JobRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTail(path: string, bytes: number): Promise<string> {
  try {
    const info = await stat(path);
    if (info.size <= bytes) return await readFile(path, "utf8");
    // Read only the tail, so a multi-gigabyte training log does not have to be
    // loaded to answer "what happened most recently".
    const handle = await (await import("node:fs/promises")).open(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, info.size - bytes);
      return `…${buffer.toString("utf8")}`;
    } finally {
      await handle.close();
    }
    // eslint-disable-next-line no-restricted-syntax -- 日志可能已被轮转或删除，读不到时返回空尾，jobStatus 的 logBytes 已经表达缺失
  } catch {
    return "";
  }
}
