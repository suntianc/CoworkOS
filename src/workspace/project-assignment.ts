import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface ProjectRecord {
  projectId: string;
  projectName: string;
  projectDirectory: string;
  createdAt: string;
  updatedAt: string;
  legacy?: boolean;
  /**
   * Set when the person removed the project from the list. The record stays so
   * its conversations keep their owner; adding the same folder again restores it.
   */
  removedAt?: string;
}

/** Read only the committed assignment; a pending transaction retains its old record. */
async function readAssignments(filePath: string): Promise<ProjectRecord[]> {
  try {
    const document = JSON.parse(await readFile(filePath, "utf8")) as {
      version?: number;
      projects?: ProjectRecord[];
    };
    if (document.version !== 1 || !Array.isArray(document.projects))
      throw new Error("项目目录索引格式损坏，请保留文件后恢复备份");
    return document.projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function assignment(projects: ProjectRecord[], projectId: string): ProjectRecord | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 归属数组来自磁盘 JSON，元素可能是 null，这里跳过而不是抛异常
  const record = projects.find((project) => project?.projectId === projectId);
  if (!record) return undefined;
  if (typeof record.projectDirectory !== "string" || !isAbsolute(record.projectDirectory))
    throw new Error("项目目录记录损坏");
  return record;
}

export async function readProjectAssignment(
  filePath: string,
  projectId: string
): Promise<ProjectRecord | undefined> {
  return assignment(await readAssignments(filePath), projectId);
}

/** Share a committed catalog only within one read batch; later reads see edits immediately. */
export function createProjectAssignmentReader(): typeof readProjectAssignment {
  const catalogs = new Map<string, Promise<ProjectRecord[]>>();
  return async (filePath, projectId) => {
    let pending = catalogs.get(filePath);
    if (!pending) {
      pending = readAssignments(filePath);
      catalogs.set(filePath, pending);
    }
    return assignment(await pending, projectId);
  };
}
