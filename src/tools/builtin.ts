import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import type { RuntimeTool } from "../runtime/tool.js";
import { configuredCommandTimeout } from "../runtime/runtime-settings.js";
import { resolveCapabilities, type ResolvedCapabilities } from "../runtime/task-capabilities.js";
import { jobStatus, killJob, listJobs, startJob } from "./jobs.js";
import { createWebTools, type WebToolOptions } from "./web-tools.js";
import {
  configuredProtectedPaths,
  projectWritesEnabled,
  atriaInstallRoot,
  type ProtectedPaths
} from "./protected-paths.js";
import { readWorkspaceText, searchWorkspaceText } from "./workspace-text.js";
import { containsFilePath, resolveFileTarget } from "./file-path.js";
import { createImageTools } from "./read-image.js";
import type { VisionModelConfig } from "./vision-model.js";
import { executeForegroundCommand } from "./foreground-command.js";
import {
  commandCaptureEvidence,
  commandDiagnosticPreview,
  commandOutputBudget,
  DEFAULT_COMMAND_MAX_LOG_BYTES,
  DEFAULT_COMMAND_PREVIEW_BYTES
} from "./command-receipt.js";

export interface BuiltinToolOptions {
  rootDirectory: string;
  /** Read-only root exposed to browse_workspace. Defaults to rootDirectory. */
  workspaceDirectory?: string;
  /** Main-only route for artifacts/<name>; Subagents never receive this option. */
  artifactDirectory?: string;
  /**
   * The user's project. When set and project writes are enabled, relative
   * paths may also reach into it, so an Agent can edit the code it is
   * optimizing instead of only a private copy. Protected paths still apply.
   */
  projectDirectory?: string;
  /** Overrides COWORK_PROJECT_WRITE for this tool set. */
  allowProjectWrites?: boolean;
  /** Overrides the environment-derived read-only guard for this tool set. */
  protectedPaths?: ProtectedPaths;
  /** Capabilities granted to this Task. Absent means the sandbox default. */
  capabilities?: ResolvedCapabilities;
  /** Per-command deadline. Defaults to COWORK_COMMAND_TIMEOUT_MS; zero means unlimited. */
  commandTimeoutMs?: number;
  /** File output cap; explicitly setting this also preserves the legacy per-stream command hard cap. */
  maxOutputBytes?: number;
  /** Per-stream command log hard cap, independent of model-visible previews. */
  commandMaxLogBytes?: number;
  /** Per-stream UTF-8 preview budget, including any omission marker. */
  commandPreviewBytes?: number;
  /** Environment overrides for commands started by this tool set. */
  commandEnv?: NodeJS.ProcessEnv;
  supportsImages?: boolean;
  visionModel?: VisionModelConfig;
  /** Optional public web tools. Omit for coding/benchmark profiles that should not access the web. */
  web?: WebToolOptions;
}

/** P1 local tools. All file paths are constrained to rootDirectory. */
export function createBuiltinTools(options: BuiltinToolOptions): ReadonlyMap<string, RuntimeTool> {
  const maxOutputBytes = options.maxOutputBytes ?? 128_000;
  const commandMaxLogBytes = commandOutputBudget(
    options.commandMaxLogBytes ?? options.maxOutputBytes ?? DEFAULT_COMMAND_MAX_LOG_BYTES,
    "commandMaxLogBytes"
  );
  const commandPreviewBytes = Math.min(
    commandOutputBudget(options.commandPreviewBytes ?? DEFAULT_COMMAND_PREVIEW_BYTES, "commandPreviewBytes"),
    commandMaxLogBytes
  );
  const commandTimeoutMs = options.commandTimeoutMs ?? configuredCommandTimeout();
  const workspaceDirectory = resolve(options.workspaceDirectory ?? options.rootDirectory);
  // A project write reaches outside the private working directory, so it is
  // opt-in; the guard over evaluation and harness code applies either way.
  const projectDirectory = options.projectDirectory ? resolve(options.projectDirectory) : undefined;
  const capabilities = options.capabilities ?? resolveCapabilities(undefined);
  const projectWrites =
    projectDirectory !== undefined && (options.allowProjectWrites ?? capabilities.projectWrite);
  const useShell = projectWrites && capabilities.shell;
  const guard =
    options.protectedPaths ??
    (projectDirectory
      ? configuredProtectedPaths(projectDirectory, process.env, [atriaInstallRoot()], capabilities.evalPaths)
      : undefined);
  const withinRoot = (root: string, normalized: string): string | undefined => {
    const candidate = resolve(root, normalized);
    return containsFilePath(root, candidate) ? candidate : undefined;
  };
  const safePath = (path: unknown): string => {
    if (typeof path !== "string" || !path || isAbsolute(path)) throw new Error("path must be relative");
    const normalized = posix.normalize(path);
    if (options.artifactDirectory && normalized.startsWith("artifacts/")) {
      const leaf = normalized.slice("artifacts/".length);
      if (
        !leaf ||
        leaf.includes("\\") ||
        leaf.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("path escapes artifact directory");
      return resolve(options.artifactDirectory, leaf);
    }
    const inWorkDir = withinRoot(options.rootDirectory, normalized);
    if (!projectWrites || !projectDirectory) {
      if (inWorkDir) return inWorkDir;
      throw new Error("path escapes workspace");
    }
    // Both roots are reachable, so a relative path is ambiguous. Resolve it to
    // whichever root actually holds the file; an existing file is what the
    // agent means far more often than a new one at the same relative path.
    const inProject = withinRoot(projectDirectory, normalized);
    if (inWorkDir && existsSync(inWorkDir)) return inWorkDir;
    if (inProject && existsSync(inProject)) return inProject;
    // Neither exists: a new file belongs in the project, which is the working
    // root once project writes are on. `work/` and `deliverables/` stay the
    // agent's own, so its scratch space is still addressable.
    if (inWorkDir && /^(work|deliverables|logs)\//.test(normalized)) return inWorkDir;
    if (inProject) return inProject;
    if (inWorkDir) return inWorkDir;
    throw new Error("path escapes workspace");
  };
  const assertMutablePath = (path: string): void => {
    const rel = relative(options.rootDirectory, path).replaceAll("\\", "/");
    // These are framework-owned files. The Main agent may maintain the
    // human-readable memory file, but must not overwrite the transcript or
    // its bookkeeping state through ordinary coding tools.
    if (rel === "context/messages.json" || rel === "context/state.json") {
      throw new Error(`${rel} is framework-managed; update context/memory.md instead`);
    }
    // The referee is not editable by a participant. This applies to Main too:
    // both are inside the loop being optimized.
    guard?.assertWritable(path);
  };
  const fileTarget = async (path: string, mutable = false): Promise<string> => {
    await assertArtifactBoundary(path);
    if (mutable) assertMutablePath(path);
    const target = await resolveFileTarget(path);
    const roots = [options.rootDirectory];
    if (projectWrites && projectDirectory) roots.push(projectDirectory);
    if (options.artifactDirectory && containsFilePath(resolve(options.artifactDirectory), path))
      roots.push(options.artifactDirectory);
    const allowed = await Promise.all(roots.map(resolveFileTarget));
    if (!allowed.some((root) => containsFilePath(root, target)))
      throw new Error("path escapes workspace through symbolic links");
    if (mutable) {
      const root = await resolveFileTarget(options.rootDirectory);
      const rel = relative(root, target).replaceAll("\\", "/");
      if (rel === "context/messages.json" || rel === "context/state.json")
        throw new Error(`${rel} is framework-managed; update context/memory.md instead`);
      await guard?.assertWritableTarget(path);
    }
    return target;
  };
  const replaceFile = async (path: string, content: string, createParents = false): Promise<void> => {
    const target = await fileTarget(path, true);
    if (createParents) await mkdir(dirname(target), { recursive: true });
    if ((await fileTarget(path, true)) !== target || (await resolveFileTarget(target)) !== target)
      throw new Error("file path changed during write; retry the operation");
    const temp = `${target}.cowork-tmp-${randomUUID()}`;
    let created = false;
    try {
      await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
      created = true;
      if ((await fileTarget(path, true)) !== target || (await resolveFileTarget(target)) !== target)
        throw new Error("file path changed during write; retry the operation");
      await rename(temp, target);
    } finally {
      if (created) await rm(temp, { force: true });
    }
  };
  const displayPath = (path: string): string => {
    if (options.artifactDirectory) {
      const rel = relative(options.artifactDirectory, path);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return `artifacts/${rel}`;
    }
    const rel = relative(options.rootDirectory, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    // A project path is reported relative to the project, so the agent sees
    // the path it used rather than a chain of parent directories.
    if (projectDirectory) {
      const projectRel = relative(projectDirectory, path);
      if (projectRel && !projectRel.startsWith("..") && !isAbsolute(projectRel)) return projectRel;
    }
    return rel;
  };
  const assertArtifactBoundary = async (path: string): Promise<void> => {
    if (!options.artifactDirectory) return;
    const root = resolve(options.artifactDirectory);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    let current = root;
    for (const part of ["", ...rel.split(/[\\/]/)]) {
      if (part) current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("artifact path must not contain symbolic links");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  };
  const read: RuntimeTool = {
    executionMode: "parallel",
    async execute(input) {
      const value = input as { path?: unknown };
      const path = safePath(value.path);
      const content = await readFile(await fileTarget(path), "utf8");
      return { path: displayPath(path), content: truncate(content, maxOutputBytes) };
    }
  };
  const write: RuntimeTool = {
    async execute(input) {
      const value = input as { path?: unknown; content?: unknown };
      const path = safePath(value.path);
      if (typeof value.content !== "string") throw new Error("write_file requires string content");
      if (Buffer.byteLength(value.content, "utf8") > maxOutputBytes * 4)
        throw new Error(`write_file content exceeds ${maxOutputBytes * 4} bytes`);
      await replaceFile(path, value.content, true);
      return { path: displayPath(path), bytes: Buffer.byteLength(value.content), changed: true };
    }
  };
  const patch: RuntimeTool = {
    async execute(input) {
      const value = input as { path?: unknown; oldText?: unknown; newText?: unknown };
      const path = safePath(value.path);
      if (typeof value.oldText !== "string" || typeof value.newText !== "string") {
        throw new Error("apply_patch requires string oldText and newText");
      }
      const target = await fileTarget(path, true);
      const before = await readFile(target, "utf8");
      const occurrences = before.split(value.oldText).length - 1;
      if (value.oldText.length === 0 || occurrences !== 1)
        throw new Error(patchGuidance(before, value.oldText, displayPath(path), occurrences));
      const after = before.replace(value.oldText, value.newText);
      if ((await fileTarget(path, true)) !== target)
        throw new Error("file path changed during patch; retry the operation");
      await replaceFile(path, after);
      return { path: displayPath(path), bytes: Buffer.byteLength(after), changed: true };
    }
  };
  const run = (defaultCommand?: string): RuntimeTool => ({
    async execute(input, signal) {
      signal?.throwIfAborted();
      const value = input as { command?: unknown; args?: unknown; cwd?: unknown };
      const command = typeof value.command === "string" ? value.command : defaultCommand;
      if (!command) throw new Error("command is required");
      const args =
        Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string") ? value.args : [];
      // With project writes on, work happens in the project, so that is where
      // a command runs unless one is named. `cwd` is resolved by the same rule
      // as a file path, so it cannot point somewhere writes could not reach.
      const cwd =
        value.cwd !== undefined
          ? await fileTarget(safePath(value.cwd))
          : projectWrites && projectDirectory
            ? projectDirectory
            : options.rootDirectory;
      const agentRoot = await resolveFileTarget(options.rootDirectory);
      const workspaceRoot = await resolveFileTarget(workspaceDirectory);
      try {
        signal?.throwIfAborted();
        const result = await executeForegroundCommand(command, args, {
          cwd,
          timeoutMs: commandTimeoutMs,
          maxOutputBytes: commandMaxLogBytes,
          previewBytes: commandPreviewBytes,
          outputLogDirectory: join(agentRoot, "logs", "commands"),
          env: options.commandEnv,
          // A pipeline this agent edits supports pipes and redirection. Work
          // that must survive this foreground call uses start_job. This widens what a command
          // string can do, which is the same latitude the file tools already
          // grant when project writes are enabled.
          shell: useShell,
          signal
        });
        return {
          command,
          args,
          cwd,
          exitCode: 0,
          ...commandCaptureEvidence(result, agentRoot, workspaceRoot),
          stdout: result.stdout,
          stderr: result.stderr
        };
      } catch (error) {
        const failure = error as {
          code?: unknown;
          stdout?: string;
          stderr?: string;
          signal?: string;
          timedOut?: boolean;
        };
        // A deadline kill and an ordinary signal both surface as `signal`, so
        // name the timeout explicitly rather than let it read as a crash.
        const cancelled = signal?.aborted === true;
        const timedOut = !cancelled && failure.timedOut === true;
        return {
          command,
          args,
          cwd,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          signal: failure.signal,
          ...(timedOut ? { timedOut, timeoutMs: commandTimeoutMs } : {}),
          ...(cancelled ? { cancelled: true } : {}),
          ...commandCaptureEvidence(failure, agentRoot, workspaceRoot),
          error: error instanceof Error ? error.message : String(error),
          stdout: failure.stdout ?? "",
          stderr:
            failure.stderr ||
            commandDiagnosticPreview(cancelled ? "Command cancelled" : String(error), commandPreviewBytes),
          failed: true,
          isError: true
        };
      }
    }
  });
  const browse: RuntimeTool = {
    executionMode: "parallel",
    async execute(input) {
      return browseWorkspace({ workspaceDirectory, maxOutputBytes }, input);
    }
  };
  const tools = new Map<string, RuntimeTool>([
    ["read_file", read],
    ["write_file", write],
    ["apply_patch", patch],
    ["run_command", run()],
    ["run_tests", run("npm")],
    ["browse_workspace", browse]
  ]);
  const imageTools = createImageTools({
    rootDirectory: options.rootDirectory,
    taskDirectory: workspaceDirectory,
    supportsImages: options.supportsImages,
    visionModel: options.visionModel,
    resolveWorkPath: (path) => fileTarget(safePath(path))
  });
  for (const [name, tool] of Object.entries(imageTools)) tools.set(name, tool);
  if (capabilities.longRunning) {
    // A Task that expects hour-long work supervises it instead of deadlining
    // it: the model starts the job, watches the log, and decides whether a
    // quiet process is working or wedged. A clock cannot make that call.
    // Records live on disk, so a job outliving this Agent can still be found.
    const directory = join(options.rootDirectory, "logs", "jobs");
    const jobCwd = () => (projectWrites && projectDirectory ? projectDirectory : options.rootDirectory);
    tools.set("start_job", {
      async execute(input) {
        const value = input as { command?: unknown; cwd?: unknown };
        if (typeof value.command !== "string" || !value.command.trim())
          throw new Error("start_job requires command");
        return startJob({
          command: value.command,
          cwd: value.cwd !== undefined ? await fileTarget(safePath(value.cwd)) : jobCwd(),
          directory,
          env: options.commandEnv,
          shell: true
        });
      }
    });
    tools.set("check_job", {
      async execute(input) {
        const value = input as { jobId?: unknown; tailBytes?: unknown };
        if (value.jobId === undefined) return { jobs: await listJobs({ directory }) };
        if (typeof value.jobId !== "string") throw new Error("check_job jobId must be a string");
        return jobStatus({
          directory,
          jobId: value.jobId,
          tailBytes: typeof value.tailBytes === "number" ? Math.min(value.tailBytes, maxOutputBytes) : 4_000
        });
      }
    });
    tools.set("kill_job", {
      async execute(input) {
        const value = input as { jobId?: unknown };
        if (typeof value.jobId !== "string") throw new Error("kill_job requires jobId");
        return killJob({ directory, jobId: value.jobId });
      }
    });
  }
  if (options.web) {
    for (const [name, tool] of createWebTools(options.web)) tools.set(name, tool);
  }
  return tools;
}

export interface BrowseWorkspaceOptions {
  workspaceDirectory: string;
  maxOutputBytes?: number;
}

/**
 * Read-only view of the Task workspace. Unlike read_file, this intentionally
 * sees the whole Task directory (artifacts, sessions, runs and all agents),
 * while write/command tools remain restricted to an Agent's own workdir.
 */
export async function browseWorkspace(options: BrowseWorkspaceOptions, rawInput: unknown): Promise<unknown> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as {
    mode?: unknown;
    path?: unknown;
    query?: unknown;
    depth?: unknown;
    maxEntries?: unknown;
    offset?: unknown;
  };
  const mode = input.mode === "read" || input.mode === "search" ? input.mode : "tree";
  const root = await resolveFileTarget(options.workspaceDirectory);
  const relativePath = typeof input.path === "string" && input.path ? input.path : ".";
  const target = await safeWorkspaceTarget(root, relativePath);
  const maxEntries = clampNumber(input.maxEntries, 1, 500, 200);
  const maxBytes = options.maxOutputBytes ?? 128_000;

  if (mode === "read") {
    let readTarget = target;
    let redirectedFrom: string | undefined;
    try {
      await stat(readTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Old callbacks may still quote a pre-migration artifact path. Follow
      // the explicit migration journal for model reads, not for the UI list.
      const journal = await readFile(resolve(root, ".runtime/artifact-migration.json"), "utf8").catch(
        // eslint-disable-next-line no-restricted-syntax -- 迁移日志在旧工作区尚不存在是预期情况，读取失败由下面的 JSON.parse 兜底为空映射
        () => "{}"
      );
      const mappings =
        (JSON.parse(journal) as { paths?: Array<{ sourcePath: string; destinationPath: string }> }).paths ??
        [];
      const mapping = mappings.find((entry) => entry.sourcePath === relative(root, target));
      if (!mapping) throw error;
      redirectedFrom = relative(root, target);
      readTarget = await safeWorkspaceTarget(root, mapping.destinationPath);
    }
    const page = await readWorkspaceText(
      readTarget,
      maxBytes,
      typeof input.offset === "number" ? input.offset : 0
    );
    return {
      mode,
      path: relative(root, readTarget) || ".",
      ...page,
      ...(redirectedFrom ? { redirectedFrom } : {})
    };
  }

  if (mode === "search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new Error("browse_workspace search mode requires query");
    const matches: Array<{ path: string; line: number; text: string }> = [];
    await searchFiles(target, root, query.toLowerCase(), matches, maxEntries);
    return {
      mode,
      path: relative(root, target) || ".",
      query,
      matches,
      truncated: matches.length >= maxEntries
    };
  }

  const depth = clampNumber(input.depth, 0, 6, 2);
  const entries: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
  await listTree(target, root, depth, entries, maxEntries);
  return {
    mode,
    path: relative(root, target) || ".",
    depth,
    entries,
    truncated: entries.length >= maxEntries
  };
}

function safeWorkspacePath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("browse_workspace path must be relative");
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}/`))
    throw new Error("browse_workspace path escapes workspace");
  return target;
}

async function safeWorkspaceTarget(root: string, relativePath: string): Promise<string> {
  const target = await resolveFileTarget(safeWorkspacePath(root, relativePath));
  if (!containsFilePath(root, target))
    throw new Error("browse_workspace path escapes workspace through symbolic links");
  return target;
}

async function listTree(
  target: string,
  root: string,
  depth: number,
  entries: Array<{ path: string; type: "file" | "directory"; size?: number }>,
  maxEntries: number
): Promise<void> {
  if (entries.length >= maxEntries) return;
  const children = await readdir(target, { withFileTypes: true });
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      entries.length >= maxEntries ||
      child.isSymbolicLink() ||
      [".git", "node_modules"].includes(child.name)
    )
      continue;
    const childPath = resolve(target, child.name);
    const rel = relative(root, childPath) || ".";
    if (child.isDirectory()) {
      entries.push({ path: rel, type: "directory" });
      if (depth > 0) await listTree(childPath, root, depth - 1, entries, maxEntries);
    } else if (child.isFile()) {
      const info = await stat(childPath);
      entries.push({ path: rel, type: "file", size: info.size });
    }
  }
}

async function searchFiles(
  target: string,
  root: string,
  query: string,
  matches: Array<{ path: string; line: number; text: string }>,
  maxEntries: number
): Promise<void> {
  const info = await stat(target);
  if (info.isFile()) {
    await searchOneFile(target, root, query, matches, maxEntries);
    return;
  }
  const children = await readdir(target, { withFileTypes: true });
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      matches.length >= maxEntries ||
      child.isSymbolicLink() ||
      [".git", "node_modules"].includes(child.name)
    )
      continue;
    const childPath = resolve(target, child.name);
    if (child.isDirectory()) await searchFiles(childPath, root, query, matches, maxEntries);
    else if (child.isFile()) await searchOneFile(childPath, root, query, matches, maxEntries);
  }
}

async function searchOneFile(
  filePath: string,
  root: string,
  query: string,
  matches: Array<{ path: string; line: number; text: string }>,
  maxEntries: number
): Promise<void> {
  try {
    const found = await searchWorkspaceText(filePath, query, maxEntries - matches.length);
    matches.push(...found.map((match) => ({ path: relative(root, filePath), ...match })));
    // eslint-disable-next-line no-restricted-syntax -- 文本搜索按目录遍历，二进制或不可读文件只从结果中缺席，无需中断整次搜索
  } catch {
    // Binary/unreadable files are intentionally ignored by the text search.
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function truncate(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n...[truncated]`;
}

/** Explain a strict patch mismatch without changing matching behavior. */
function patchGuidance(before: string, oldText: string, path: string, occurrences: number): string {
  if (oldText.length === 0)
    return `oldText must not be empty in ${path}; read_file first and provide the exact text to replace.`;
  if (occurrences > 1) {
    const lines: number[] = [];
    let offset = before.indexOf(oldText);
    while (offset !== -1 && lines.length < 5) {
      lines.push(before.slice(0, offset).split("\n").length);
      offset = before.indexOf(oldText, offset + oldText.length);
    }
    return `oldText must match exactly once (matched ${occurrences}) in ${path}; matches start at lines ${lines.join(", ")}${occurrences > lines.length ? ", ..." : ""}. Use read_file to inspect the current file, then add surrounding context so the text matches exactly once.`;
  }
  const anchor = oldText
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .reduce((longest, line) => (line.length > longest.length ? line : longest), "");
  const lines: number[] = [];
  if (anchor.length >= 8) {
    for (const [index, line] of before.split("\n").entries()) {
      if (line.includes(anchor)) lines.push(index + 1);
      if (lines.length === 5) break;
    }
  }
  const hint = lines.length
    ? ` An anchor from oldText occurs at lines ${lines.join(", ")}; inspect these locations, since the surrounding text may differ.`
    : " No location hint is available.";
  return `oldText must match exactly once (matched 0) in ${path}.${hint} Use read_file to inspect the current file, then copy its text verbatim, including whitespace, and add sufficient surrounding context. Prefer retrying apply_patch for a small edit; use write_file for an intentional whole-file replacement rather than rewriting the file through bash, Python or a heredoc merely because matching failed.`;
}
