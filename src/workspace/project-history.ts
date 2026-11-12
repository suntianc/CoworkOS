import { readFile, readdir, realpath } from "node:fs/promises";
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
