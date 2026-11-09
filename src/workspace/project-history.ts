import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

interface HistoryEntry {
  type?: string;
  customType?: string;
  cwd?: string;
  data?: { taskId?: string; workspaceRoot?: string; projectDirectory?: string };
}

async function canonical(value: string): Promise<string> {
  const path = resolve(value);
  try {
    return await realpath(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return path;
    throw error;
  }
}

async function inferredDirectory(
  entries: Array<HistoryEntry | null>,
  storageRoot: string,
  taskId: string
): Promise<string | undefined> {
  const canonicalRoot = await canonical(storageRoot);
  for (const entry of [...entries].reverse()) {
    const data = entry?.data;
    if (
      entry?.type === "custom" &&
      entry.customType === "atria-cli-task" &&
      data?.taskId === taskId &&
      typeof data.workspaceRoot === "string" &&
      (await canonical(data.workspaceRoot)) === canonicalRoot &&
      typeof data.projectDirectory === "string" &&
      isAbsolute(data.projectDirectory)
    )
      return resolve(data.projectDirectory);
  }
  // A conflicting CLI binding cannot be rescued by a foreign header.
  if (entries.some((entry) => entry?.type === "custom" && entry.customType === "atria-cli-task"))
    return undefined;
  const header = entries.find(
    (entry) => entry?.type === "session" && typeof entry.cwd === "string" && isAbsolute(entry.cwd)
  );
  if (!header?.cwd) return undefined;
  const directory = resolve(header.cwd);
  const withinTask = relative(await canonical(join(storageRoot, taskId)), await canonical(directory));
  return withinTask === "" || (!withinTask.startsWith("..") && !isAbsolute(withinTask))
    ? undefined
    : directory;
}

/** Older CLI tasks kept their project only in Pi history, before Task metadata did. */
export async function inferLegacyProjectDirectory(
  storageRoot: string,
  taskId: string
): Promise<string | undefined> {
  try {
    const entries = JSON.parse(
      await readFile(join(storageRoot, taskId, "agents", "main", "context", "messages.json"), "utf8")
    ) as unknown;
    if (Array.isArray(entries)) {
      const directory = await inferredDirectory(entries, storageRoot, taskId);
      if (directory) return directory;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const sessions = join(storageRoot, taskId, "sessions", "main", "pi");
  const files = await readdir(sessions).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of files
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse()) {
    try {
      const entries = (await readFile(join(sessions, file), "utf8"))
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as HistoryEntry];
            // eslint-disable-next-line no-restricted-syntax -- 进程中断会留下半行 JSONL，损坏的单行跳过即可，后面还有其它会话文件可读
          } catch {
            return [];
          }
        });
      const directory = await inferredDirectory(entries, storageRoot, taskId);
      if (directory) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/** Read-only evidence: never delete catalog rows or repair/move user resources while listing projects. */
export async function applicationProjectEvidence(
  roots: string[],
  projects: Array<{ projectId: string; projectDirectory: string }>,
  internalRoot: string
): Promise<Set<string>> {
  const evidence = new Set<string>();
  for (const root of roots) {
    const applications = join(root, "applications");
    // eslint-disable-next-line no-restricted-syntax -- 工作区根不一定有 applications 目录，缺目录就是没有应用证据，不能因此让项目列表失败
    for (const app of await readdir(applications, { withFileTypes: true }).catch(() => [])) {
      if (!app.isDirectory() || app.name === "instances") continue;
      const resources = join(applications, app.name, "resources");
      // eslint-disable-next-line no-restricted-syntax -- 应用没装资源就没有 resources 目录，缺目录表示没有证据可收集
      for (const resource of await readdir(resources, { withFileTypes: true }).catch(() => [])) {
        if (!resource.isDirectory()) continue;
        try {
          const metadata = JSON.parse(
            await readFile(join(resources, resource.name, "metadata.json"), "utf8")
          ) as {
            resourceId?: string;
            path?: string;
            externalPath?: string;
            project?: { projectId?: string } | null;
            projectId?: string;
          };
          if (metadata.resourceId !== resource.name || typeof metadata.path !== "string") continue;
          const file = metadata.externalPath ?? resolve(applications, app.name, "files", metadata.path);
          const within = relative(join(applications, app.name, "files"), file);
          if (!metadata.externalPath && (within.startsWith("..") || isAbsolute(within))) continue;
          if (!(await stat(file)).isFile()) continue;
          if (typeof metadata.project?.projectId === "string") evidence.add(metadata.project.projectId);
          else if (metadata.project === undefined && typeof metadata.projectId === "string")
            evidence.add(metadata.projectId);
          else if (metadata.project === undefined && resolve(root) !== resolve(internalRoot)) {
            for (const project of projects)
              if (resolve(project.projectDirectory) === resolve(root)) evidence.add(project.projectId);
          }
          // eslint-disable-next-line no-restricted-syntax -- 目录里的残留 metadata.json 可能已损坏，读不了就不提供证据，且绝不修改这些文件
        } catch {
          /* Unreadable remnants supply no evidence; preserve every original file. */
        }
      }
    }
  }
  return evidence;
}
