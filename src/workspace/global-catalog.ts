import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";

interface CatalogDocument {
  version: 1;
  workspaces: Array<{ workspaceRoot: string; firstSeenAt: string; lastSeenAt: string }>;
}

/**
 * The task files stay inside their own workspace. This small global catalog
 * only remembers which workspace roots the desktop has seen, so the UI can
 * present one history grouped by project without moving or duplicating task
 * data.
 */
export class GlobalWorkspaceCatalog {
  constructor(private readonly filePath: string) {}

  async register(workspaceRoot: string): Promise<void> {
    const root = resolve(workspaceRoot);
    const timestamp = new Date().toISOString();
    await withFileLock(this.filePath, async () => {
      const current = await this.readDocument();
      const existing = current.workspaces.find((entry) => entry.workspaceRoot === root);
      if (existing) {
        existing.lastSeenAt = timestamp;
      } else {
        current.workspaces.push({ workspaceRoot: root, firstSeenAt: timestamp, lastSeenAt: timestamp });
      }
      current.workspaces.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
  }

  async list(): Promise<string[]> {
    const document = await this.readDocument();
    return document.workspaces.map((entry) => entry.workspaceRoot);
  }

  private async readDocument(): Promise<CatalogDocument> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<CatalogDocument>;
      const workspaces = Array.isArray(value.workspaces)
        ? value.workspaces.flatMap((entry) => {
            if (
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- workspaces 来自磁盘 JSON，数组元素可能是 null 或非对象
              !entry ||
              typeof entry !== "object" ||
              typeof entry.workspaceRoot !== "string" ||
              !entry.workspaceRoot.trim()
            )
              return [];
            const root = resolve(entry.workspaceRoot);
            const now = new Date().toISOString();
            return [
              {
                workspaceRoot: root,
                firstSeenAt: typeof entry.firstSeenAt === "string" ? entry.firstSeenAt : now,
                lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : now
              }
            ];
          })
        : [];
      return { version: 1, workspaces };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
      // A damaged index must not hide task data. It is safe to rebuild from
      // the current workspace and any roots registered later.
      return { version: 1, workspaces: [] };
    }
  }
}
