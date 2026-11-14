import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { containsFilePath, resolveFileTarget } from "./file-path.js";
import { readWorkspaceText, searchWorkspaceText } from "./workspace-text.js";

/**
 * The read-only view of a Task workspace.
 *
 * Main and delegated agents both expose it as `browse_workspace`; unlike their
 * own read tools it deliberately sees the whole Task directory (artifacts,
 * sessions, runs and every agent), while writes stay inside one agent's workdir.
 */

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
