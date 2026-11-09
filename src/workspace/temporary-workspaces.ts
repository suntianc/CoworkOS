import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface TemporaryWorkspace {
  version: 1;
  workspaceId: string;
  holdingTaskId: string;
  taskStorageRoot: string;
  createdAt: string;
  retention: "until-explicit-discard";
}
const fileName = ".atria-temporary-workspace.json";
/** Durable product data, never OS temporary storage. Closing a tab does not remove it. */
export class TemporaryWorkspaceStore {
  readonly directory: string;
  constructor(dataDirectory: string) {
    this.directory = join(resolve(dataDirectory), "temporary-workspaces");
  }
  async create(taskStorageRoot: string): Promise<{ root: string; record: TemporaryWorkspace }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(taskStorageRoot, { recursive: true });
    const storageRoot = await realpath(taskStorageRoot);
    const workspaceId = randomUUID();
    const root = join(await realpath(this.directory), workspaceId);
    const staging = join(await realpath(this.directory), `.pending-${workspaceId}`);
    await mkdir(staging, { mode: 0o700 });
    const record: TemporaryWorkspace = {
      version: 1,
      workspaceId,
      holdingTaskId: `temporary-${workspaceId}`,
      taskStorageRoot: storageRoot,
      createdAt: new Date().toISOString(),
      retention: "until-explicit-discard"
    };
    const handle = await open(join(staging, fileName), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, root);
    return { root, record };
  }
  async roots(): Promise<string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    );
    const roots: string[] = [];
    if (!entries.length) return roots;
    const parent = await realpath(this.directory);
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.name)
      )
        continue;
      const root = join(parent, entry.name);
      if ((await realpath(root)) !== resolve(root)) throw new Error("临时工作区路径不能是符号链接");
      const record = await readTemporaryWorkspace(root);
      if (!record || record.workspaceId !== entry.name) throw new Error("临时工作区记录与目录不一致");
      roots.push(root);
    }
    return roots;
  }
}
export async function readTemporaryWorkspace(root: string): Promise<TemporaryWorkspace | undefined> {
  let raw: string;
  try {
    const handle = await open(join(root, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error("临时工作区记录无效");
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const value = JSON.parse(raw) as Partial<TemporaryWorkspace> | null;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.workspaceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.workspaceId) ||
    value.holdingTaskId !== `temporary-${value.workspaceId}` ||
    typeof value.taskStorageRoot !== "string" ||
    !isAbsolute(value.taskStorageRoot) ||
    /[\u0000-\u001f]/.test(value.taskStorageRoot) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.retention !== "until-explicit-discard"
  )
    throw new Error("临时工作区记录无效");
  if (!isAbsolute(root) || basename(root) !== value.workspaceId || (await realpath(root)) !== resolve(root))
    throw new Error("临时工作区路径与记录不一致");
  return value as TemporaryWorkspace;
}
