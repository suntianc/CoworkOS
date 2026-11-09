import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { WorkspaceResource } from "./types.js";

/** Read older origin records into the one canonical persisted identity format. */
export async function normalizeArtifactImportOrigin(
  value: unknown
): Promise<WorkspaceResource["importedArtifact"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const root = source.storageRoot ?? source.workspaceRoot;
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    /[\u0000-\u001f\u007f]/.test(root) ||
    typeof source.taskId !== "string" ||
    typeof source.relativePath !== "string" ||
    typeof source.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    return undefined;
  return {
    // eslint-disable-next-line no-restricted-syntax -- 工作区目录可能已被移走，realpath 失败时保留记录里的绝对路径
    storageRoot: await realpath(root).catch(() => resolve(root)),
    taskId: source.taskId,
    relativePath: source.relativePath,
    sha256: source.sha256
  };
}
