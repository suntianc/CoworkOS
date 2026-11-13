import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";
import { withFileLock } from "../storage/file-lock.js";
import { now } from "../domain/types.js";
import {
  processGroupIsAlive,
  processIsAlive,
  readProcessIdentity,
  verifyProcessIdentity
} from "./process-identity.js";
import type { ReviewConclusion } from "./subagent-review.js";

/**
 * The process model Main and delegated agents share.
 *
 * A backend launches an agent as its own Pi process group, so the process is
 * not a child whose life the backend owns: a backend restart or upgrade must
 * not end work already in flight. The backend stays the manager for the rest of
 * the life of that process — it observes the exit while it is the parent, and
 * re-adopts a still-running process after a restart by checking the pid against
 * the OS start time recorded at launch. A pid on its own is never enough.
 */
export type AgentProcessRole = "main" | "executor" | "reviewer";

export type AgentProcessStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

/** What a settled process leaves for its backend to project. */
export interface AgentProcessOutcome {
  status: AgentProcessStatus;
  response: string;
  outputFiles: string[];
  diagnostics: AgentProcessDiagnostics;
  /** A Reviewer's structured conclusion, kept with the recorded outcome. */
  review?: ReviewConclusion;
  error?: string;
}

export interface AgentProcessDiagnostics {
  tracePath: string;
  resultPath: string;
}

export interface AgentProcessLaunch {
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  role: AgentProcessRole;
  /** The work item's site; the process runs with this as its CWD. */
  workingDirectory: string;
  /**
   * The project an agent edits, when it differs from the CWD.
   *
   * A delegated agent's CWD is its site. Main runs from the install root but
   * works in the project the Task selected.
   */
  projectDirectory?: string;
  /** The turn handed to the agent on stdin; absent for a resident process. */
  prompt?: string;
  /**
   * How long this process lives.
   *
   * `turn` (the default) runs one prompt and exits. `resident` keeps the
   * process available between turns: it is started in Pi's long-lived RPC
   * interface, its stdin stays open for the life of the process, and its own
   * durable Inbox is what wakes it for the next turn.
   */
  mode?: "turn" | "resident";
  /** Called with each stdout chunk of a resident process, in arrival order. */
  onStdout?: (chunk: Buffer) => void;
  /** Called with each stderr chunk of a resident process, in arrival order. */
  onStderr?: (chunk: Buffer) => void;
  /** Session selection for a resident process, replacing the per-call id. */
  sessionArgs?: string[];
  /** Pi session directory; one call keeps its own transcript. */
  sessionDirectory: string;
  /** The extension writes this record before the process exits. */
  resultPath: string;
  /** Model, workspace and configuration facts for the child. */
  env: NodeJS.ProcessEnv;
  /** Durable queue lease this process is fulfilling, renewed while it runs. */
  leaseToken?: string;
  /** Extra launcher arguments appended after the shared ones. */
  args?: string[];
}

export interface AgentProcessRecord {
  version: 1;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  role: AgentProcessRole;
  pid: number;
  host: string;
  /** OS process start identity; a reused pid does not match it. */
  startedAt: string;
  token: string;
  launchedAt: string;
  workingDirectory: string;
  sessionDirectory: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  leaseToken?: string;
  /** OS exit facts, recorded when this backend observed the exit itself. */
  exitCode?: number | null;
  exitSignal?: string | null;
  settledAt?: string;
  outcome?: AgentProcessOutcome;
}

export interface AgentProcessHostOptions {
  workspaceRoot: string;
  harnessRoot: string;
  /** Connection facts and configuration inherited by every launched process. */
  env?: NodeJS.ProcessEnv;
  /** Absolute launcher path, for a host that installs its own entry. */
  launcher?: string;
  /** Called once per process when it is observed to have exited. */
  onExit?: (record: AgentProcessRecord) => Promise<void> | void;
  /**
   * Called once the launch record exists, before the caller gets it back.
   *
   * A caller that must report the spawned handle (so a stop can be awaited on
   * the process it actually ended) needs it from the host that owns it.
   */
  onSpawn?: (record: AgentProcessRecord, child: ChildProcess) => void;
  /** How often an adopted (not parented) process is checked for liveness. */
  pollMs?: number;
  /** SIGTERM→SIGKILL window when the backend stops a process. */
  graceMs?: number;
}

/** The directory an agent's durable process records live in. */
export function agentProcessDirectory(
  workspaceRoot: string,
  taskId: string,
  runId: string,
  role: AgentProcessRole,
  agentId: string
): string {
  return join(
    workspaceRoot,
    taskId,
    "runs",
    runId,
    "agents",
    role === "main" ? "main" : join("subagents", agentId)
  );
}

export function agentProcessRecordPath(
  workspaceRoot: string,
  taskId: string,
  runId: string,
  role: AgentProcessRole,
  agentId: string
): string {
  return join(agentProcessDirectory(workspaceRoot, taskId, runId, role, agentId), "process.json");
}

export class AgentProcessHost {
  private readonly workspaceRoot: string;
  private readonly harnessRoot: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly launcher: string;
  private readonly onExit?: (record: AgentProcessRecord) => Promise<void> | void;
  private readonly onSpawn?: (record: AgentProcessRecord, child: ChildProcess) => void;
  private readonly pollMs: number;
  private readonly graceMs: number;
  private readonly children = new Map<string, ChildProcess>();
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly settling = new Map<string, Promise<void>>();

  constructor(options: AgentProcessHostOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.harnessRoot = resolve(options.harnessRoot);
    this.baseEnv = options.env ?? {};
    this.launcher = options.launcher ?? join(this.harnessRoot, "scripts", "start-pi.mjs");
    this.onExit = options.onExit;
    this.onSpawn = options.onSpawn;
    this.pollMs = Math.max(100, options.pollMs ?? 2_000);
    this.graceMs = Math.max(100, options.graceMs ?? 2_000);
  }

  /**
   * Start one agent process group and record who it is before handing back.
   *
   * The record is durable before the prompt is delivered: a backend that dies
   * in between leaves an adoption record for the process it just created
   * instead of an unowned child.
   */
  async launch(input: AgentProcessLaunch): Promise<AgentProcessRecord> {
    const token = randomUUID();
    const directory = agentProcessDirectory(
      this.workspaceRoot,
      input.taskId,
      input.runId,
      input.role,
      input.agentId
    );
    const stdoutPath = join(directory, "agent-output.log");
    const stderrPath = join(directory, "agent-stderr.log");
    const env = this.launchEnv(input, token);
    await mkdir(directory, { recursive: true });
    const resident = input.mode === "resident";
    const stdout = resident ? undefined : await open(stdoutPath, "a");
    const stderr = resident ? undefined : await open(stderrPath, "a");
    let child: ChildProcess;
    let spawnFailure: Promise<Error>;
    // A process that dies during this launch's own awaits must still settle.
    // `close` fires once, whether or not anyone is listening yet, so the
    // listener is attached before the next await and the result is reconciled
    // after the record exists instead of waiting for an event that already
    // happened.
    const exit = { happened: false };
    let record: AgentProcessRecord | undefined;
    try {
      child = spawn(process.execPath, this.launchArgs(input), {
        cwd: input.workingDirectory,
        env,
        // A separate group is what lets the backend stop the whole tree and
        // what keeps it alive when the backend itself goes away.
        detached: process.platform !== "win32",
        stdio: ["pipe", resident ? "pipe" : stdout!.fd, resident ? "pipe" : stderr!.fd]
      });
      // A resident process owns its stdout, so the backend can follow its
      // turns; the same bytes still go to the durable log beside the record.
      if (resident) {
        child.stderr?.on("data", (chunk: Buffer) => input.onStderr?.(chunk));
        let logWrites = Promise.resolve();
        child.stdout?.on("data", (chunk: Buffer) => {
          // Keep the durable log complete without reordering chunks; the
          // caller parses the same bytes immediately.
          logWrites = logWrites
            .then(() => appendFile(stdoutPath, chunk))
            // eslint-disable-next-line no-restricted-syntax -- 诊断日志写入失败不影响事件流与进程生命周期
            .catch(() => {});
          input.onStdout?.(chunk);
        });
      }
      // A spawn failure is reported asynchronously on `error` and leaves no
      // pid. Attach the listener before the next await (closing the parent's
      // file handles yields to the event loop): an unhandled `error` event
      // would crash the backend, and the launch would never be settled.
      spawnFailure = new Promise<Error>((resolve) => child.once("error", resolve));
      child.once("close", (code, signal) => {
        exit.happened = true;
        if (!record) return;
        this.children.delete(recordKey(record));
        const closed = { ...record, exitCode: code, exitSignal: signal };
        void (async () => {
          // Keep the exit facts for the projection that follows; a crash and a
          // clean stop must not look the same to the caller.
          // eslint-disable-next-line no-restricted-syntax -- 退出信息只是结算输入，记录写不进去时仍按内存中的退出事实结算
          await this.writeRecord(closed).catch(() => {});
          await this.settle(closed);
        })();
      });
    } finally {
      // The child owns its copies; the parent closes its own handles.
      await stdout?.close();
      await stderr?.close();
    }
    const pid = child.pid;
    if (!pid) {
      const failure = await Promise.race([
        spawnFailure,
        pause(2_000).then(() => new Error("no process was created"))
      ]);
      throw new Error(`Agent process did not start: ${failure.message}`);
    }
    const identity = await readProcessIdentity(pid);
    record = {
      version: 1,
      taskId: input.taskId,
      runId: input.runId,
      callId: input.callId,
      agentId: input.agentId,
      role: input.role,
      pid,
      host: hostname(),
      startedAt: identity?.startedAt ?? "",
      token,
      launchedAt: now(),
      workingDirectory: input.workingDirectory,
      sessionDirectory: input.sessionDirectory,
      resultPath: input.resultPath,
      stdoutPath,
      stderrPath,
      ...(input.leaseToken ? { leaseToken: input.leaseToken } : {})
    };
    await this.writeRecord(record);
    this.children.set(recordKey(record), child);
    this.onSpawn?.(record, child);
    child.stdin?.on("error", () => {
      /* a closed stdin is not a launch failure; close settles the process */
    });
    if (input.prompt !== undefined) child.stdin?.end(input.prompt);
    // `close` also fires after an asynchronous spawn error, so one settlement
    // path covers normal exits and process-level errors. It may already have
    // fired while the identity and record were being written.
    if (exit.happened || child.exitCode !== null || child.signalCode !== null) {
      this.children.delete(recordKey(record));
      const closed = { ...record, exitCode: child.exitCode, exitSignal: child.signalCode };
      void (async () => {
        // The exit facts are part of the record a later reader (or a backend
        // that adopts the workspace) uses to tell a crash from an idle stop.
        // eslint-disable-next-line no-restricted-syntax -- 退出信息只是结算输入，写不进去时仍按内存中的退出事实结算
        await this.writeRecord(closed).catch(() => {});
        await this.settle(closed);
      })();
    }
    return record;
  }

  /**
   * Take over the processes a previous backend started for this Run.
   *
   * A live process is observed by polling the identity written at launch; one
   * that ended while no backend was watching is settled from its durable
   * records, so Main still receives the callback it was owed.
   */
  async adopt(input: { taskId: string; runId: string }): Promise<AgentProcessRecord[]> {
    const records = await this.records(input.taskId, input.runId);
    const adopted: AgentProcessRecord[] = [];
    for (const record of records) {
      if (record.settledAt) continue;
      if (this.children.has(recordKey(record))) {
        adopted.push(record);
        continue;
      }
      const live = await this.owns(record);
      if (!live) {
        await this.settle(record);
        continue;
      }
      adopted.push(record);
      this.watch(record);
    }
    return adopted;
  }

  /**
   * Whether the recorded pid is still the process this system launched.
   *
   * A pid alone is not an identity: every delegated agent is a detached group
   * leader, so a recycled pid can belong to a sibling's process group. Only a
   * matching host and OS start time authorises a signal or an adoption.
   */
  async owns(record: AgentProcessRecord): Promise<boolean> {
    if (record.host !== hostname()) return false;
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
    return verifyProcessIdentity({ pid: record.pid, startedAt: record.startedAt });
  }

  /** Stop one process group and let its exit settle the record. */
  async stop(record: AgentProcessRecord): Promise<void> {
    // Signalling is the destructive step: never send one to a pid that no
    // longer matches the identity written at launch. A mismatch means the
    // process already ended, so settle from its durable records instead.
    if (!(await this.owns(record))) {
      await this.settle(record);
      return;
    }
    if (!processGroupIsAlive(record.pid)) {
      await this.settle(record);
      return;
    }
    signalGroup(record.pid, "SIGTERM");
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline && processGroupIsAlive(record.pid)) await pause(this.pollMs);
    // The launcher can exit before a descendant in the same group; the group,
    // not the recorded pid, is what must be gone when stop resolves. The
    // identity is checked again here because the grace window is long enough
    // for the recorded leader to end and its number to be reused by an
    // unrelated group; a signal is only sent to the process this host started.
    if (processGroupIsAlive(record.pid) && (await this.owns(record))) signalGroup(record.pid, "SIGKILL");
    await this.settle(record);
  }

  /** Record the queue lease this process currently holds. */
  async updateLease(record: AgentProcessRecord, leaseToken: string): Promise<void> {
    await this.writeRecord({ ...record, leaseToken });
  }

  /** Stop watching every adopted process; used by a backend that is shutting down. */
  close(): void {
    for (const watcher of this.watchers.values()) clearInterval(watcher);
    this.watchers.clear();
  }

  async records(taskId: string, runId: string): Promise<AgentProcessRecord[]> {
    const agents = join(this.workspaceRoot, taskId, "runs", runId, "agents");
    const paths = [join(agents, "main", "process.json")];
    const subagents = join(agents, "subagents");
    const entries = await readdir(subagents, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        // A Run with no delegated process yet has no subagents directory.
        if (error.code === "ENOENT") return [];
        throw error;
      }
    );
    for (const entry of entries)
      if (entry.isDirectory()) paths.push(join(subagents, entry.name, "process.json"));
    const records: AgentProcessRecord[] = [];
    for (const path of paths) {
      const value = await readRecord(path);
      if (value) records.push(value);
    }
    return records;
  }

  async record(input: {
    taskId: string;
    runId: string;
    role: AgentProcessRole;
    agentId: string;
  }): Promise<AgentProcessRecord | undefined> {
    return readRecord(
      agentProcessRecordPath(this.workspaceRoot, input.taskId, input.runId, input.role, input.agentId)
    );
  }

  /** Persist the outcome the backend projected from the process's result record. */
  async markSettled(record: AgentProcessRecord, outcome: AgentProcessOutcome): Promise<void> {
    const settled: AgentProcessRecord = {
      ...record,
      settledAt: record.settledAt ?? now(),
      outcome
    };
    await this.writeRecord(settled);
  }

  /**
   * Record that this process is gone and its projection is complete.
   *
   * `settledAt` is what stops a second observer — an adoption pass after a
   * restart, or a poll racing the close event — from projecting the same exit
   * twice. A projection that writes its own outcome first keeps it. The record
   * is only marked when it still describes this process: a relaunch for the
   * same Run reuses the path, and an old exit must not settle the new one.
   */
  async markExited(record: AgentProcessRecord): Promise<void> {
    const path = agentProcessRecordPathFor(record);
    const current = await readRecord(path);
    if (current && !sameProcess(current, record)) return;
    if (current?.settledAt) return;
    await this.writeRecord({ ...(current ?? record), settledAt: now() });
  }

  private async settle(record: AgentProcessRecord): Promise<void> {
    const key = recordKey(record);
    const existing = this.settling.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const watcher = this.watchers.get(key);
      if (watcher) {
        clearInterval(watcher);
        this.watchers.delete(key);
      }
      // The parent's close event, an adoption pass and a poll can all arrive.
      // The durable record is the one place that says whether somebody already
      // settled it, and the lock makes "check, project, mark" one decision.
      try {
        await withFileLock(
          `${agentProcessRecordPathFor(record)}.settle`,
          async () => {
            const current = await readRecord(agentProcessRecordPathFor(record));
            // The path can already describe a newer process for the same Run;
            // projecting an old exit from it would settle the wrong one.
            const same = current === undefined || sameProcess(current, record);
            if (same && current?.settledAt) return;
            try {
              await this.onExit?.(same && current ? current : record);
            } catch (error) {
              // Settlement failures are logged, not fatal: the record stays
              // unsettled so the next adoption retries.
              console.error(
                `[cowork] agent process settlement failed: ${error instanceof Error ? error.message : String(error)}`
              );
              return;
            }
            await this.markExited(record);
          },
          { recoverDeadOwner: true }
        );
      } catch (error) {
        // The workspace itself can be going away (a stopped host or a removed
        // temporary directory) while a close event arrives. Nothing is left to
        // reconcile there, and the rejection has no caller that could handle
        // it: settlement is always a background projection.
        console.error(
          `[cowork] agent process record unavailable during settlement: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })().finally(() => this.settling.delete(key));
    this.settling.set(key, operation);
    return operation;
  }

  private watch(record: AgentProcessRecord): void {
    const key = recordKey(record);
    if (this.watchers.has(key)) return;
    const watcher = setInterval(() => {
      void (async () => {
        if (await verifyProcessIdentity({ pid: record.pid, startedAt: record.startedAt })) return;
        await this.settle(record);
      })();
    }, this.pollMs);
    this.watchers.set(key, watcher);
  }

  private launchArgs(input: AgentProcessLaunch): string[] {
    const resident = input.mode === "resident";
    return [
      this.launcher,
      ...(resident ? ["--mode", "rpc"] : ["--print", "--mode", "json"]),
      "--session-dir",
      input.sessionDirectory,
      // A resident process continues one Pi session for the life of the
      // process; its caller chose how to select it.
      ...(input.sessionArgs ?? ["--session-id", input.callId]),
      ...(input.args ?? [])
    ];
  }

  private launchEnv(input: AgentProcessLaunch, token: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.baseEnv,
      ...input.env,
      COWORK_HARNESS_ROOT: this.harnessRoot,
      COWORK_WORKSPACE: this.workspaceRoot,
      COWORK_PROJECT_DIR: input.projectDirectory ?? input.workingDirectory,
      COWORK_TASK_ID: input.taskId,
      COWORK_RUN_ID: input.runId,
      COWORK_CLI_SESSION: "0",
      // Only a delegated process takes the launcher's role branch; Main keeps
      // its own launch path and its own project directory.
      ...(input.role === "main" ? {} : { COWORK_AGENT_ROLE: input.role, COWORK_AGENT_ID: input.agentId }),
      ...(input.mode === "resident" ? { COWORK_MAIN_RESIDENT: "1" } : {}),
      PI_OFFLINE: "1"
    };
    if (input.role !== "main") {
      env.COWORK_SUBAGENT_CALL_ID = input.callId;
      env.COWORK_SUBAGENT_TOKEN = token;
      env.COWORK_SUBAGENT_RESULT = input.resultPath;
    }
    return env;
  }

  private async writeRecord(record: AgentProcessRecord): Promise<void> {
    await atomicWrite(agentProcessRecordPathFor(record), `${JSON.stringify(record, null, 2)}\n`);
  }
}

/** Whether two records describe the same launched process. */
function sameProcess(left: AgentProcessRecord, right: AgentProcessRecord): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.token === right.token;
}

function recordKey(record: Pick<AgentProcessRecord, "runId" | "callId">): string {
  return `${record.runId}:${record.callId}`;
}

function agentProcessRecordPathFor(record: AgentProcessRecord): string {
  return join(dirname(record.stdoutPath), "process.json");
}

async function readRecord(path: string): Promise<AgentProcessRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<AgentProcessRecord>;
    if (
      value.version !== 1 ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.taskId !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.agentId !== "string" ||
      typeof value.callId !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.resultPath !== "string"
    )
      return undefined;
    return value as AgentProcessRecord;
    // eslint-disable-next-line no-restricted-syntax -- 记录尚未写入或已损坏时视为没有可接管的进程；调用方从队列恢复而不是猜测一个 pid
  } catch {
    return undefined;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
    // eslint-disable-next-line no-restricted-syntax -- 进程组可能在信号发出前已退出（ESRCH）；退出由 settle 从记录与 pid 复盘
  } catch {
    /* the process group has already exited */
  }
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, ms));
}
