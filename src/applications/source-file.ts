import { createHash } from "node:crypto";
import { extname } from "node:path";
import { ApplicationError, type WorkspaceResource, type ApplicationDefinition } from "./types.js";
import type { ResourceFiles } from "./resource-files.js";

export const sourceVersion = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
export async function inspectSourceFile(
  files: ResourceFiles,
  definition: ApplicationDefinition,
  input: { path: string; contentVersion: string }
): Promise<NonNullable<WorkspaceResource["sourceFile"]>> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- sourceFile 来自 create 请求体（HTTP/工具参数），调用方可能传 null 或非字符串 path
  if (!input || typeof input.path !== "string" || !/^[a-f0-9]{64}$/.test(input.contentVersion))
    throw new ApplicationError("invalid_operation", "原文件路径或版本无效", {});
  const path = await files.adoptExternalPath(input.path);
  const ext = extname(path).toLowerCase();
  const formats: Record<string, string> = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".json": "resource"
  };
  const format = formats[ext];
  if (!format || (format !== "resource" && !definition.exportFormats.includes(format)))
    throw new ApplicationError("unsupported_resource_kind", "此应用不能保存回原文件格式", { path });
  const body = await files.readBytes({ appType: definition.appType, path: "", externalPath: path });
  if (sourceVersion(body) !== input.contentVersion)
    throw new ApplicationError("source_file_conflict", "文件在打开期间发生变化，请重新打开", { path });
  return { path, format, contentVersion: input.contentVersion, savedRevision: 0 };
}
