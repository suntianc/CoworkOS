import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../storage/file-lock.js";

export interface Artifact {
  artifactId: string;
  taskId: string;
  runId: string;
  producerAgentId: string;
  relativePath: string;
  sha256: string;
  size: number;
  createdAt: string;
  displayName?: string;
  mimeType?: string;
  mtimeMs?: number;
  /** Export origin, valid only while the published bytes retain this hash. */
  sourceResource?: { resourceId: string; sha256: string };
}

interface TaskLocation {
  workspaceRoot: string;
  taskId: string;
}
interface TaskPaths {
  task: string;
  artifacts: string;
  runtime: string;
  index: string;
}
interface CacheEntry {
  artifact: Artifact;
  ctimeMs: number;
  dev: number;
  ino: number;
}
interface ArtifactCache {
  version: 1;
  entries: CacheEntry[];
}
interface ArtifactMetadata {
  sourceResourceId?: string;
  runId?: string;
  producerAgentId?: string;
  displayName?: string;
  mimeType?: string;
  createdAt?: string;
}
export interface ArtifactMigrationPath {
  sourcePath: string;
  destinationPath: string;
  action: "moved" | "copied" | "deduplicated";
}
interface MigrationJournal {
  version: 1;
  completedAt?: string;
  paths: ArtifactMigrationPath[];
}
export interface ArtifactMigrationResult {
  migrated: boolean;
  moved: number;
  imported: number;
  paths: ArtifactMigrationPath[];
}

class UnsafeArtifactPath extends Error {}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === "." || value === "..")
    throw new UnsafeArtifactPath(`unsafe workspace segment: ${value}`);
  return value;
}

function pathParts(value: string): string[] {
  if (!value || isAbsolute(value) || /^[a-zA-Z]:/.test(value) || /[\\\x00-\x1f\x7f]/.test(value))
    throw new UnsafeArtifactPath(`unsafe artifact path: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new UnsafeArtifactPath(`unsafe artifact path: ${value}`);
  return parts;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Resolve each component, rejecting links even when they point back into the task. */
async function directory(root: string, parts: string[], create = false): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new UnsafeArtifactPath(`unsafe artifact directory: ${current}`);
  }
  if (!inside(root, await realpath(current)))
    throw new UnsafeArtifactPath("artifact directory escapes task workspace");
  return current;
}

async function taskPaths(input: TaskLocation, create = false): Promise<TaskPaths> {
  safeSegment(input.taskId);
  const requestedRoot = resolve(input.workspaceRoot);
  if (create) await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const task = await directory(root, [input.taskId], create);
  return {
    task,
    artifacts: join(task, "artifacts"),
    runtime: join(task, ".runtime"),
    index: join(task, ".runtime", "artifacts.json")
  };
}

async function checkedFile(
  root: string,
  relativePath: string
): Promise<{ absolutePath: string; stat: Stats }> {
  const parts = pathParts(relativePath);
  const parent = await directory(root, parts.slice(0, -1));
  const absolutePath = join(parent, parts.at(-1)!);
  const details = await lstat(absolutePath);
  if (details.isSymbolicLink() || !details.isFile())
    throw new UnsafeArtifactPath(`artifact is not a regular file: ${relativePath}`);
  if (!inside(root, await realpath(absolutePath)))
    throw new UnsafeArtifactPath("artifact path escapes artifacts directory");
  return { absolutePath, stat: details };
}

async function readJson(path: string): Promise<unknown> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile())
    throw new UnsafeArtifactPath(`unsafe metadata file: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCache(paths: TaskPaths): Promise<ArtifactCache> {
  try {
    const value = (await readJson(paths.index)) as Partial<ArtifactCache> | null;
    if (value?.version === 1 && Array.isArray(value.entries)) {
      return {
        version: 1,
        entries: value.entries.filter(
          (entry) =>
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 缓存来自磁盘 JSON，旧文件数组元素可能是 null 或缺少 artifact
            entry?.artifact &&
            typeof entry.artifact.relativePath === "string" &&
            typeof entry.artifact.sha256 === "string"
        )
      };
    }
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return { version: 1, entries: [] };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

async function saveCache(paths: TaskPaths, cache: ArtifactCache): Promise<void> {
  cache.entries.sort(
    (a, b) =>
      (b.artifact.mtimeMs ?? 0) - (a.artifact.mtimeMs ?? 0) ||
      a.artifact.relativePath.localeCompare(b.artifact.relativePath)
  );
  await writeJson(paths.index, cache);
}

async function activeRun(paths: TaskPaths): Promise<string> {
  try {
    const task = (await readJson(join(paths.task, "task.json"))) as { activeRunId?: unknown };
    if (typeof task.activeRunId === "string" && task.activeRunId) return task.activeRunId;
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError) && !(error instanceof UnsafeArtifactPath))
      throw error;
  }
  return "workspace";
}

function mimeType(path: string): string {
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav"
  };
  const extension = extname(path).toLowerCase();
  if (
    [
      ".py",
      ".ts",
      ".tsx",
      ".jsx",
      ".sh",
      ".bash",
      ".zsh",
      ".yml",
      ".yaml",
      ".toml",
      ".ini",
      ".xml",
      ".sql",
      ".diff",
      ".patch",
      ".r",
      ".rs",
      ".go",
      ".c",
      ".h",
      ".cpp",
      ".java",
      ".ipynb",
      ".env"
    ].includes(extension)
  )
    return "text/plain";
  if (["Dockerfile", "Makefile", "LICENSE", ".gitignore", ".env"].includes(basename(path)))
    return "text/plain";
  return types[extension] ?? "application/octet-stream";
}

function unchanged(entry: CacheEntry, details: Stats): boolean {
  return (
    entry.artifact.size === details.size &&
    entry.artifact.mtimeMs === details.mtimeMs &&
    entry.ctimeMs === details.ctimeMs &&
    entry.dev === details.dev &&
    entry.ino === details.ino
  );
}

/** Hash with bounded memory; never turn a large PDF/archive into a Buffer. */
async function hashFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile())
      throw new UnsafeArtifactPath(`artifact is not a regular file: ${path}`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function indexFile(
  paths: TaskPaths,
  input: TaskLocation,
  relativePath: string,
  previous?: CacheEntry,
  metadata: ArtifactMetadata = {}
): Promise<{ entry: CacheEntry; absolutePath: string; stat: Stats }> {
  const file = await checkedFile(paths.artifacts, relativePath);
  const cached = previous && unchanged(previous, file.stat);
  const sha256 = cached ? previous.artifact.sha256 : await hashFile(file.absolutePath);
  const after = await checkedFile(paths.artifacts, relativePath);
  if (
    file.stat.size !== after.stat.size ||
    file.stat.mtimeMs !== after.stat.mtimeMs ||
    file.stat.ctimeMs !== after.stat.ctimeMs ||
    file.stat.ino !== after.stat.ino
  ) {
    throw new Error(`artifact changed while being indexed: ${relativePath}`);
  }
  const legacyResourceId =
    previous && /^exports\/(res_[a-zA-Z0-9_-]+)\/[a-f0-9]{8}-[^/]+$/.exec(relativePath)?.[1];
  const sourceResource = metadata.sourceResourceId
    ? { resourceId: metadata.sourceResourceId, sha256 }
    : (previous?.artifact.sourceResource ??
      (legacyResourceId && previous.artifact.displayName === basename(relativePath).slice(9)
        ? { resourceId: legacyResourceId, sha256: previous.artifact.sha256 }
        : undefined));
  const artifact: Artifact = {
    artifactId: `artifact_${createHash("sha256").update(`${input.taskId}\0${relativePath}`).digest("hex").slice(0, 24)}`,
    taskId: input.taskId,
    runId: metadata.runId ?? previous?.artifact.runId ?? "workspace",
    producerAgentId: metadata.producerAgentId ?? previous?.artifact.producerAgentId ?? "main",
    relativePath,
    sha256,
    size: file.stat.size,
    createdAt:
      previous?.artifact.createdAt ??
      metadata.createdAt ??
      new Date(file.stat.birthtimeMs || file.stat.mtimeMs).toISOString(),
    displayName: metadata.displayName ?? previous?.artifact.displayName ?? basename(relativePath),
    mimeType: metadata.mimeType ?? previous?.artifact.mimeType ?? mimeType(relativePath),
    mtimeMs: file.stat.mtimeMs,
    ...(sourceResource ? { sourceResource } : {})
  };
  return { entry: { artifact, ctimeMs: file.stat.ctimeMs, dev: file.stat.dev, ino: file.stat.ino }, ...file };
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    await directory(root, prefix ? pathParts(prefix) : []);
    entries = await readdir(prefix ? join(root, prefix) : root, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** artifacts/ is authoritative, including files written with ordinary model tools. */
export async function listTaskArtifacts(input: TaskLocation & { runId?: string }): Promise<Artifact[]> {
  let paths;
  try {
    paths = await taskPaths(input);
    await directory(paths.task, ["artifacts"]);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  await directory(paths.task, [".runtime"], true);
  return withFileLock(paths.index, async () => {
    const cache = await readCache(paths);
    const old = new Map(cache.entries.map((entry) => [entry.artifact.relativePath, entry]));
    const fallbackRun = input.runId ?? (await activeRun(paths));
    const entries: CacheEntry[] = [];
    for (const relativePath of await filesUnder(paths.artifacts)) {
      try {
        const previous = old.get(relativePath);
        const { entry } = await indexFile(
          paths,
          input,
          relativePath,
          previous,
          previous ? {} : { runId: fallbackRun }
        );
        entries.push(entry);
      } catch (error) {
        if (
          !missing(error) &&
          !(error instanceof UnsafeArtifactPath) &&
          !String(error).includes("artifact changed while being indexed")
        )
          throw error;
      }
    }
    await saveCache(paths, { version: 1, entries });
    return entries.map((entry) => entry.artifact);
  });
}

/** Downloads/previews share the exact same containment checks as indexing. */
export async function resolveTaskArtifact(
  input: TaskLocation & { relativePath: string }
): Promise<{ absolutePath: string; stat: Stats; artifact: Artifact }> {
  pathParts(input.relativePath);
  const paths = await taskPaths(input);
  await directory(paths.task, ["artifacts"]);
  await checkedFile(paths.artifacts, input.relativePath);
  await directory(paths.task, [".runtime"], true);
  return withFileLock(paths.index, async () => {
    const cache = await readCache(paths);
    const previous = cache.entries.find((entry) => entry.artifact.relativePath === input.relativePath);
    const result = await indexFile(
      paths,
      input,
      input.relativePath,
      previous,
      previous ? {} : { runId: await activeRun(paths) }
    );
    cache.entries = [
      ...cache.entries.filter((entry) => entry.artifact.relativePath !== input.relativePath),
      result.entry
    ];
    await saveCache(paths, cache);
    return { absolutePath: result.absolutePath, stat: result.stat, artifact: result.entry.artifact };
  });
}

export async function publishTaskArtifact(
  input: TaskLocation &
    ArtifactMetadata & {
      runId: string;
      producerAgentId: string;
      relativePath: string;
      sourcePath?: string;
      content?: string | Uint8Array;
    }
): Promise<Artifact> {
  const parts = pathParts(input.relativePath);
  safeSegment(input.runId);
  safeSegment(input.producerAgentId);
  if ((input.sourcePath !== undefined) === (input.content !== undefined))
    throw new Error("provide exactly one of sourcePath or content");
  const paths = await taskPaths(input, true);
  await directory(paths.task, ["artifacts"], true);
  await directory(paths.task, [".runtime", "artifact-staging"], true);
  return withFileLock(paths.index, async () => {
    const parent = await directory(paths.artifacts, parts.slice(0, -1), true);
    const target = join(parent, parts.at(-1)!);
    try {
      await checkedFile(paths.artifacts, input.relativePath);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = join(paths.runtime, "artifact-staging", randomUUID());
    let source;
    try {
      if (input.sourcePath !== undefined) {
        source = await open(input.sourcePath, "r");
        if (!(await source.stat()).isFile()) throw new Error("artifact source must be a regular file");
      }
      const stream = source
        ? source.createReadStream()
        : Readable.from([typeof input.content === "string" ? Buffer.from(input.content) : input.content!]);
      await pipeline(stream, createWriteStream(temporary, { flags: "wx" }));
      const output = await open(temporary, "r+");
      try {
        await output.sync();
      } finally {
        await output.close();
      }
      await directory(paths.artifacts, parts.slice(0, -1));
      try {
        await checkedFile(paths.artifacts, input.relativePath);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await rename(temporary, target);
      const cache = await readCache(paths);
      const previous = cache.entries.find((entry) => entry.artifact.relativePath === input.relativePath);
      const { entry } = await indexFile(paths, input, input.relativePath, previous, input);
      cache.entries = [
        ...cache.entries.filter((candidate) => candidate.artifact.relativePath !== input.relativePath),
        entry
      ];
      await saveCache(paths, cache);
      return entry.artifact;
    } finally {
      await source?.close();
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  });
}

function legacyArtifact(value: unknown, taskId: string): value is Artifact {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Artifact>;
  return (
    entry.taskId === taskId &&
    typeof entry.artifactId === "string" &&
    typeof entry.relativePath === "string" &&
    typeof entry.runId === "string" &&
    typeof entry.producerAgentId === "string" &&
    typeof entry.sha256 === "string" &&
    typeof entry.size === "number"
  );
}

function agentDirectory(agentId: string): string {
  safeSegment(agentId);
  return agentId === "main" || agentId === "coordinator"
    ? `agents/${agentId}`
    : `agents/subagents/${agentId}`;
}

/** Only generated names inside their manifest-declared run/agent namespace qualify. */
function legacyDestination(entry: Artifact): string | undefined {
  safeSegment(entry.runId);
  const agent = agentDirectory(entry.producerAgentId);
  const parts = pathParts(entry.relativePath);
  if (parts[0] !== entry.runId || parts[1] !== entry.producerAgentId) return undefined;
  const suffix = parts.slice(2).join("/");
  if ([`${entry.runId}.jsonl`, `trace-${entry.runId}.jsonl`, `result-${entry.runId}.json`].includes(suffix)) {
    return `${agent}/logs/${entry.runId}/legacy-artifacts/${suffix}`;
  }
  if (parts[2] === "deliverables" && parts.length > 3) {
    const name = parts.slice(3).join("/");
    return entry.producerAgentId === "main"
      ? `artifacts/${name}`
      : `${agent}/outputs/legacy-artifacts/${entry.runId}/${name}`;
  }
  return undefined;
}

/** Preserve existing bytes; a conflict gets a stable content-derived filename. */
async function transferLegacy(
  paths: TaskPaths,
  sourcePath: string,
  destinationPath: string,
  move: boolean
): Promise<ArtifactMigrationPath> {
  const source = await checkedFile(paths.task, sourcePath);
  const parts = pathParts(destinationPath);
  await directory(paths.task, parts.slice(0, -1), true);
  let candidate = destinationPath;
  let sourceHash: string | undefined;
  for (let attempt = 0; ; attempt += 1) {
    let existing;
    try {
      existing = await checkedFile(paths.task, candidate);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (existing) {
      if (existing.stat.size === source.stat.size) {
        sourceHash ??= await hashFile(source.absolutePath);
        if (sourceHash === (await hashFile(existing.absolutePath))) {
          if (move && source.absolutePath !== existing.absolutePath) await unlink(source.absolutePath);
          return { sourcePath, destinationPath: candidate, action: "deduplicated" };
        }
      }
      sourceHash ??= await hashFile(source.absolutePath);
      const extension = extname(destinationPath);
      const stem = extension ? destinationPath.slice(0, -extension.length) : destinationPath;
      candidate = `${stem}.legacy-${sourceHash.slice(0, 12)}${attempt ? `-${attempt}` : ""}${extension}`;
      continue;
    }
    const target = join(paths.task, ...pathParts(candidate));
    try {
      if (move) {
        // link is atomic and never overwrites a colliding target, unlike rename.
        try {
          await link(source.absolutePath, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyFile(source.absolutePath, target, constants.COPYFILE_EXCL);
        }
        await unlink(source.absolutePath);
      } else await copyFile(source.absolutePath, target, constants.COPYFILE_EXCL);
      return { sourcePath, destinationPath: candidate, action: move ? "moved" : "copied" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function pruneEmptyParents(paths: TaskPaths, sourcePath: string): Promise<void> {
  let current = dirname(join(paths.task, sourcePath));
  while (current !== paths.artifacts && inside(paths.artifacts, current)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (!missing(error) && !["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      break;
    }
    current = dirname(current);
  }
}

/** Explicit one-time upgrade. Discovery itself never promotes agent candidates. */
export async function migrateLegacyTaskArtifacts(input: TaskLocation): Promise<ArtifactMigrationResult> {
  const paths = await taskPaths(input);
  await directory(paths.task, ["artifacts"]);
  await directory(paths.task, [".runtime"], true);
  const journalPath = join(paths.runtime, "artifact-migration.json");
  return withFileLock(journalPath, async () => {
    let journal: MigrationJournal = { version: 1, paths: [] };
    try {
      const prior = (await readJson(journalPath)) as MigrationJournal;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 迁移日志从磁盘 JSON 读取，旧文件的 version 不一定是 1
      if (prior.version === 1 && Array.isArray(prior.paths)) journal = prior;
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    const result: ArtifactMigrationResult = { migrated: false, moved: 0, imported: 0, paths: journal.paths };
    if (journal.completedAt) return result;
    // An empty array (or even an Artifact-shaped array) can be a user's final
    // manifest. Only the explicit legacy layout makes its old role unambiguous.
    let task: { layoutVersion?: unknown } | null;
    try {
      task = (await readJson(join(paths.task, "task.json"))) as { layoutVersion?: unknown } | null;
    } catch (error) {
      if (missing(error) || error instanceof SyntaxError) return result;
      throw error;
    }
    if (task?.layoutVersion !== 2) return result;
    const manifestPath = join(paths.artifacts, "manifest.json");
    let manifest: unknown;
    try {
      manifest = await readJson(manifestPath);
    } catch (error) {
      if (missing(error) || error instanceof SyntaxError) return result;
      throw error;
    }
    if (!Array.isArray(manifest) || !manifest.every((entry) => legacyArtifact(entry, input.taskId)))
      return result;
    const originalHash = await hashFile(manifestPath);
    const record = async (mapping: ArtifactMigrationPath) => {
      if (
        !journal.paths.some(
          (entry) =>
            entry.sourcePath === mapping.sourcePath &&
            entry.destinationPath === mapping.destinationPath &&
            entry.action === mapping.action
        )
      )
        journal.paths.push(mapping);
      await writeJson(journalPath, journal);
    };
    const backup = await transferLegacy(
      paths,
      "artifacts/manifest.json",
      ".runtime/legacy-artifacts-manifest.json",
      false
    );
    await record(backup);
    for (const entry of manifest) {
      let destination;
      try {
        destination = legacyDestination(entry);
      } catch (error) {
        if (error instanceof UnsafeArtifactPath) continue;
        throw error;
      }
      if (!destination) continue;
      try {
        const mapping = await transferLegacy(paths, `artifacts/${entry.relativePath}`, destination, true);
        await record(mapping);
        result.moved += 1;
        await pruneEmptyParents(paths, mapping.sourcePath);
      } catch (error) {
        if (!missing(error) && !(error instanceof UnsafeArtifactPath)) throw error;
      }
    }
    // Old Main runs wrote finished deliverables privately without registering them.
    // Import them only in this explicit legacy upgrade, retaining the originals.
    let mainFiles: string[] = [];
    try {
      await directory(paths.task, ["agents", "main", "deliverables"]);
      mainFiles = await filesUnder(join(paths.task, "agents", "main", "deliverables"));
    } catch (error) {
      if (!missing(error) && !(error instanceof UnsafeArtifactPath)) throw error;
    }
    for (const file of mainFiles) {
      try {
        const mapping = await transferLegacy(
          paths,
          `agents/main/deliverables/${file}`,
          `artifacts/${file}`,
          false
        );
        await record(mapping);
        if (mapping.action === "copied") result.imported += 1;
      } catch (error) {
        if (!missing(error) && !(error instanceof UnsafeArtifactPath)) throw error;
      }
    }
    if ((await hashFile(manifestPath)) !== originalHash)
      throw new Error(
        "legacy artifact manifest changed during migration; retry when legacy writers have stopped"
      );
    await unlink(manifestPath);
    await record({
      sourcePath: "artifacts/manifest.json",
      destinationPath: backup.destinationPath,
      action: "moved"
    });
    // Keep provenance for the user-authored files that remain in artifacts/.
    await withFileLock(paths.index, async () => {
      const cache = await readCache(paths);
      const entries = new Map(cache.entries.map((entry) => [entry.artifact.relativePath, entry]));
      for (const previous of manifest) {
        try {
          const { entry } = await indexFile(
            paths,
            input,
            previous.relativePath,
            entries.get(previous.relativePath),
            previous
          );
          entries.set(previous.relativePath, entry);
        } catch (error) {
          if (!missing(error) && !(error instanceof UnsafeArtifactPath)) throw error;
        }
      }
      await saveCache(paths, { version: 1, entries: [...entries.values()] });
    });
    journal.completedAt = new Date().toISOString();
    await writeJson(journalPath, journal);
    result.migrated = true;
    return result;
  });
}
