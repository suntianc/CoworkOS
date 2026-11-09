import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ProcessHost } from "../runtime/process-host.js";
import { id, now } from "../domain/types.js";
import { stableJson } from "./management-commands.js";

export type ProjectCloneState = "cloning" | "completed" | "failed" | "cancelled";

export interface ProjectCloneProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

export interface ProjectCloneView {
  cloneId: string;
  state: ProjectCloneState;
  progress: number;
  branch?: string;
  error?: string;
  project?: ProjectCloneProject;
}

export interface ProjectCloneInput {
  remoteUrl: string;
  destination: string;
  branch?: string;
  operationId?: string;
}

interface ProjectCloneRecord extends ProjectCloneView {
  version: 1;
  /** Sanitized for diagnostics; credentials never reach this file. */
  remoteUrl: string;
  destination: string;
  operationId?: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export class ProjectCloneError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string
  ) {
    super(message);
    this.name = "ProjectCloneError";
  }
}

interface RunningClone {
  child: ChildProcess;
  cancelled: boolean;
  percent: number;
  output: string;
  done: Promise<void>;
}

const CLONE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const URL_LIMIT = 2000;
const PATH_LIMIT = 4096;
const BRANCH_LIMIT = 200;
const OUTPUT_LIMIT = 8000;
const STALE_ERROR = "克隆被中断，未完成的文件夹已清理";
const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new ProjectCloneError(`${field}不能为空`, 400, "clone_input_invalid");
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new ProjectCloneError(`${field}过长`, 400, "clone_input_invalid");
  if (/[\0\r\n]/.test(trimmed))
    throw new ProjectCloneError(`${field}包含非法字符`, 400, "clone_input_invalid");
  return trimmed;
}

/** A URL shown to a person or written beside the catalog never carries credentials. */
function safeRemote(value: string): string {
  return value.replace(/\/\/[^/@\s]+@/g, "//");
}

function cloneId(value: string): string {
  if (!CLONE_ID.test(value)) throw new ProjectCloneError("克隆记录不存在", 404, "clone_not_found");
  return value;
}

function parseProgress(output: string): number | undefined {
  const matches = [...output.matchAll(/(\d{1,3})%/g)];
  const last = matches.at(-1);
  return last ? Math.min(100, Number(last[1])) : undefined;
}

const NOISE =
  /^(Cloning into|remote:|Receiving objects|Resolving deltas|Updating files|Checking out files|Compressing objects|Enumerating objects|Counting objects|Total )/i;

/** The line that names what went wrong is more useful than git's summary. */
function failureMessage(output: string, code: number | null): string {
  // Git may echo the remote it was given; a credential embedded there must not
  // reach a response, a record or a log.
  const lines = safeRemote(output)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^fatal:\s*/i, ""))
    .filter((line) => line && !NOISE.test(line));
  const authentication = lines.find((line) =>
    /permission denied|authentication failed|could not read username|publickey/i.test(line)
  );
  if (authentication) return authentication.replace(/^[^\s@]+@[^\s:]+:\s*/, "");
  const last = lines.at(-1);
  if (last) return last;
  return code === null ? "无法启动 Git 克隆" : `Git 克隆失败（退出码 ${code}）`;
}

function fingerprintOf(input: { remoteUrl: string; destination: string; branch?: string }): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export interface ProjectCloneService {
  /** Resolves after stale records were reconciled; every operation waits for it. */
  readonly ready: Promise<void>;
  start(input: ProjectCloneInput): Promise<ProjectCloneView>;
  status(value: string): Promise<ProjectCloneView>;
  cancel(value: string): Promise<ProjectCloneView>;
  stop(): Promise<void>;
}

/**
 * Clone a repository into a new folder and register it as a project.
 *
 * The record is the operation's durable identity: it is written before git
 * starts, a repeated operation id returns it, cancellation removes the folder
 * it created, and startup turns any record no process owns into a failure.
 * Project registration happens only after git exits successfully, so an
 * interrupted clone is never registered.
 */
export function createProjectCloneService(options: {
  dataRoot: string;
  createProject: (input: { projectName: string; projectDirectory: string }) => Promise<ProjectCloneProject>;
  gitCommand?: string;
}): ProjectCloneService {
  const directory = resolve(options.dataRoot);
  const gitCommand = options.gitCommand ?? "git";
  const host = new ProcessHost();
  const running = new Map<string, RunningClone>();

  const recordPath = (value: string) => join(directory, `${value}.json`);

  async function write(record: ProjectCloneRecord): Promise<void> {
    await mkdir(directory, { recursive: true });
    const path = recordPath(record.cloneId);
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  function recordOf(value: unknown): ProjectCloneRecord | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<ProjectCloneRecord>;
    if (
      candidate.version !== 1 ||
      typeof candidate.cloneId !== "string" ||
      typeof candidate.destination !== "string" ||
      typeof candidate.fingerprint !== "string" ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.updatedAt !== "string" ||
      !["cloning", "completed", "failed", "cancelled"].includes(String(candidate.state))
    )
      return undefined;
    return candidate as ProjectCloneRecord;
  }

  async function list(): Promise<ProjectCloneRecord[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ProjectCloneRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(directory, name), "utf8"));
        // eslint-disable-next-line no-restricted-syntax -- a half-written record from a crash cannot be trusted; its clone id still names the folder recovery must clean up
      } catch {
        continue;
      }
      const record = recordOf(parsed);
      if (record) records.push(record);
    }
    return records;
  }

  async function readRecord(value: string): Promise<ProjectCloneRecord | undefined> {
    try {
      return recordOf(JSON.parse(await readFile(recordPath(value), "utf8")));
      // eslint-disable-next-line no-restricted-syntax -- a missing record is the 404 path; damaged JSON is treated the same way because the folder alone is not a clone identity
    } catch {
      return undefined;
    }
  }

  function view(record: ProjectCloneRecord): ProjectCloneView {
    const live = running.get(record.cloneId);
    return {
      cloneId: record.cloneId,
      state: record.state,
      progress:
        record.state === "completed" ? 100 : live ? Math.max(live.percent, record.progress) : record.progress,
      ...(record.branch === undefined ? {} : { branch: record.branch }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.project === undefined ? {} : { project: record.project })
    };
  }

  async function removeDestination(destination: string): Promise<string | undefined> {
    try {
      // Only the folder this operation created is removed; it is always a
      // fresh absolute path that did not exist before the clone started.
      await rm(destination, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function finish(record: ProjectCloneRecord, state: RunningClone, failure?: string): Promise<void> {
    running.delete(record.cloneId);
    if (state.cancelled) {
      const cleanup = await removeDestination(record.destination);
      await write({
        ...record,
        state: "cancelled",
        progress: 0,
        ...(cleanup ? { error: `已取消，但未能清理目标文件夹：${cleanup}` } : { error: undefined }),
        updatedAt: now(),
        project: undefined
      });
      return;
    }
    if (failure !== undefined) {
      const cleanup = await removeDestination(record.destination);
      await write({
        ...record,
        state: "failed",
        progress: 0,
        error: cleanup ? `${failure}（未能清理目标文件夹：${cleanup}）` : failure,
        updatedAt: now(),
        project: undefined
      });
      return;
    }
    let project: ProjectCloneProject;
    try {
      project = await options.createProject({
        projectName: basename(record.destination),
        projectDirectory: record.destination
      });
    } catch (error) {
      await removeDestination(record.destination);
      await write({
        ...record,
        state: "failed",
        progress: 0,
        error: `克隆完成但注册项目失败：${error instanceof Error ? error.message : String(error)}`,
        updatedAt: now(),
        project: undefined
      });
      return;
    }
    await write({
      ...record,
      state: "completed",
      progress: 100,
      error: undefined,
      project,
      updatedAt: now()
    });
  }

  async function launch(record: ProjectCloneRecord, remoteUrl: string): Promise<void> {
    const args = ["clone", "--progress", "--single-branch"];
    if (record.branch) args.push("--branch", record.branch);
    args.push("--", remoteUrl, record.destination);
    let child: ChildProcess;
    try {
      child = host.start(`project-clone:${record.cloneId}`, gitCommand, args, {
        cwd: dirname(record.destination),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      await removeDestination(record.destination);
      await write({
        ...record,
        state: "failed",
        progress: 0,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: now()
      });
      return;
    }
    let resolveDone = () => {};
    const state: RunningClone = {
      child,
      cancelled: false,
      percent: 0,
      output: "",
      done: new Promise<void>((done) => {
        resolveDone = done;
      })
    };
    running.set(record.cloneId, state);
    const collect = (chunk: Buffer) => {
      state.output = `${state.output}${chunk.toString()}`.slice(-OUTPUT_LIMIT);
      const percent = parseProgress(state.output);
      if (percent !== undefined) state.percent = percent;
    };
    child.stderr?.on("data", collect);
    child.stdout?.on("data", collect);
    let settled = false;
    const settle = (failure?: string) => {
      if (settled) return;
      settled = true;
      void finish(record, state, failure).finally(resolveDone);
    };
    child.once("error", (error) => {
      const missingGit = (error as NodeJS.ErrnoException).code === "ENOENT";
      settle(missingGit ? "找不到 Git，请先安装 Git 并确认它在 PATH 中" : error.message);
    });
    child.once("close", (code) => settle(code === 0 ? undefined : failureMessage(state.output, code)));
  }

  async function recover(): Promise<void> {
    const records = await list();
    for (const record of records) {
      if (record.state === "cloning") {
        await removeDestination(record.destination);
        await write({ ...record, state: "failed", progress: 0, error: STALE_ERROR, updatedAt: now() });
        continue;
      }
      // Completed records stay for operation-id retries; older ones are history.
      if (Date.now() - Date.parse(record.updatedAt) > STALE_AFTER_MS)
        await rm(recordPath(record.cloneId), { force: true });
    }
  }
  const ready = recover();

  async function normalize(
    input: ProjectCloneInput
  ): Promise<{ remoteUrl: string; destination: string; branch?: string; operationId?: string }> {
    const remoteUrl = text(input.remoteUrl, "仓库地址", URL_LIMIT);
    const destination = resolve(text(input.destination, "克隆位置", PATH_LIMIT));
    if (!isAbsolute(destination))
      throw new ProjectCloneError("克隆位置必须是本机绝对路径", 400, "clone_input_invalid");
    let branch: string | undefined;
    if (input.branch !== undefined && String(input.branch).trim()) {
      branch = text(input.branch, "分支", BRANCH_LIMIT);
      if (/\s/.test(branch))
        throw new ProjectCloneError("分支名称不能包含空白字符", 400, "clone_input_invalid");
    }
    let operationId: string | undefined;
    if (input.operationId !== undefined && String(input.operationId).trim()) {
      const value = String(input.operationId).trim();
      if (!OPERATION_ID.test(value))
        throw new ProjectCloneError("操作标识格式不合法", 400, "clone_input_invalid");
      operationId = value;
    }
    return { remoteUrl, destination, ...(branch ? { branch } : {}), ...(operationId ? { operationId } : {}) };
  }

  async function start(input: ProjectCloneInput): Promise<ProjectCloneView> {
    await ready;
    const normalized = await normalize(input);
    const fingerprint = fingerprintOf(normalized);
    if (normalized.operationId) {
      const existing = (await list()).find((record) => record.operationId === normalized.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ProjectCloneError("同一操作标识不能提交不同的克隆请求", 409, "clone_operation_conflict");
        return view(existing);
      }
    }
    if (!(await missing(normalized.destination)))
      throw new ProjectCloneError("目标文件夹已存在，请选择其他位置", 409, "clone_target_exists");
    const parent = dirname(normalized.destination);
    try {
      if (!(await stat(parent)).isDirectory())
        throw new ProjectCloneError("目标位置的上级文件夹不是目录", 400, "clone_input_invalid");
    } catch (error) {
      if (error instanceof ProjectCloneError) throw error;
      throw new ProjectCloneError("目标位置的上级文件夹不存在", 400, "clone_input_invalid");
    }
    const record: ProjectCloneRecord = {
      version: 1,
      cloneId: id("clone"),
      remoteUrl: safeRemote(normalized.remoteUrl),
      destination: normalized.destination,
      ...(normalized.operationId ? { operationId: normalized.operationId } : {}),
      ...(normalized.branch ? { branch: normalized.branch } : {}),
      fingerprint,
      state: "cloning",
      progress: 0,
      createdAt: now(),
      updatedAt: now()
    };
    try {
      await mkdir(normalized.destination);
    } catch (error) {
      throw new ProjectCloneError(
        `无法创建目标文件夹：${error instanceof Error ? error.message : String(error)}`,
        400,
        "clone_target_unwritable"
      );
    }
    await write(record);
    // Git needs the original URL, including any embedded credentials; the
    // durable record keeps only the sanitized form.
    await launch(record, normalized.remoteUrl);
    return view(record);
  }

  async function status(value: string): Promise<ProjectCloneView> {
    await ready;
    const record = await readRecord(cloneId(value));
    if (!record) throw new ProjectCloneError("克隆记录不存在", 404, "clone_not_found");
    return view(record);
  }

  async function cancel(value: string): Promise<ProjectCloneView> {
    await ready;
    const record = await readRecord(cloneId(value));
    if (!record) throw new ProjectCloneError("克隆记录不存在", 404, "clone_not_found");
    if (record.state !== "cloning") return view(record);
    const state = running.get(record.cloneId);
    if (!state) {
      await removeDestination(record.destination);
      await write({ ...record, state: "failed", progress: 0, error: STALE_ERROR, updatedAt: now() });
      return view((await readRecord(record.cloneId)) as ProjectCloneRecord);
    }
    state.cancelled = true;
    await host.stopKey(`project-clone:${record.cloneId}`);
    await state.done;
    const next = await readRecord(record.cloneId);
    return next ? view(next) : { cloneId: record.cloneId, state: "cancelled", progress: 0 };
  }

  async function stop(): Promise<void> {
    await ready;
    const pending = [...running.values()];
    for (const state of pending) state.cancelled = true;
    await host.stop();
    await Promise.all(pending.map((state) => state.done));
  }

  return { ready, start, status, cancel, stop };
}
