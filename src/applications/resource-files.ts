import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atriaInstallRoot, configuredProtectedPaths } from "../tools/protected-paths.js";
import { atomicWrite, missing } from "./fs-utils.js";
import { ApplicationError, RESOURCE_LIMITS, safeIdentifier, type WorkspaceResource } from "./types.js";

type ResourceFile = Pick<WorkspaceResource, "appType" | "path" | "externalPath">;

/** File addressing belongs here; revisioning and transactions belong to ResourceStore. */
export class ResourceFiles {
  constructor(
    private readonly workspaceRoot: string,
    private readonly contentLimit: (appType: string) => number = () => RESOURCE_LIMITS.contentBytes
  ) {}

  directory(appType: string): string {
    return join(resolve(this.workspaceRoot), "applications", safeIdentifier(appType, "appType"), "files");
  }

  relativePath(value: string): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      /[\u0000-\u001f]/.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new ApplicationError("unsafe_path", `不安全的资源路径：${value}`, { path: value });
    }
    return value;
  }

  workspacePath(appType: string, path: string): string {
    const directory = this.directory(appType);
    const target = resolve(directory, this.relativePath(path));
    const suffix = relative(directory, target);
    if (suffix.startsWith("..") || isAbsolute(suffix)) {
      throw new ApplicationError("unsafe_path", "资源文件越出应用目录", { path });
    }
    return target;
  }

  absolutePath(resource: ResourceFile): string {
    return resource.externalPath
      ? checkedExternalPath(resource.externalPath)
      : this.workspacePath(resource.appType, resource.path);
  }

  async identity(resource: ResourceFile): Promise<{ dev: number; ino: number }> {
    const path = await this.checkedAccess(resource);
    const details = await this.assertFile(path);
    return { dev: details.dev, ino: details.ino };
  }

  /** Resolve parent symlinks before protection checks; never adopt a symlink as a file. */
  async adoptExternalPath(value: string): Promise<string> {
    const path = checkedExternalPath(value);
    await this.assertFile(path);
    return checkedExternalPath(join(await realpath(dirname(path)), basename(path)));
  }

  async read(resource: ResourceFile): Promise<string> {
    return (await this.readBytes(resource, this.contentLimit(resource.appType))).toString("utf8");
  }

  async readBytes(resource: ResourceFile, limit = 64 * 1024 * 1024): Promise<Buffer> {
    const path = await this.checkedAccess(resource);
    // O_NOFOLLOW closes the gap between checking a file and opening it.
    await this.assertFile(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new ApplicationError("unsafe_path", "资源文件不是普通文件", { path });
      if (details.size > limit) {
        throw new ApplicationError("resource_too_large", "资源文件过大", {
          limit
        });
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async readIfPresent(resource: ResourceFile): Promise<string | undefined> {
    try {
      return await this.read(resource);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "resource_not_found") return undefined;
      throw error;
    }
  }

  async write(resource: ResourceFile, body: string, options?: { exclusive?: boolean }): Promise<void> {
    const path = await this.checkedAccess(resource);
    // An external document must already exist; a missing one is not ours to recreate.
    const details = resource.externalPath ? await this.assertFile(path) : undefined;
    if (details) await access(path, constants.W_OK);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, body, { ...(details ? { mode: details.mode & 0o777 } : {}), ...options });
  }

  async writeBytes(
    resource: ResourceFile,
    body: string | Uint8Array,
    expectedVersion: string
  ): Promise<void> {
    const path = await this.checkedAccess(resource);
    const details = await this.assertFile(path);
    await access(path, constants.W_OK);
    const current = await this.readBytes(resource);
    if (createHash("sha256").update(current).digest("hex") !== expectedVersion)
      throw new ApplicationError(
        "source_file_conflict",
        "原文件已被其他软件修改，请重新打开文件；当前修改已保留",
        { path }
      );
    await atomicWrite(path, body, { mode: details.mode & 0o777 });
  }

  async saveCopy(
    directory: string,
    fileName: string,
    body: string | Uint8Array,
    previousVersion?: string
  ): Promise<string> {
    const parent = await realpath(directory);
    const path = checkedExternalPath(join(parent, this.relativePath(fileName)));
    if (dirname(path) !== parent) throw new ApplicationError("unsafe_path", "保存文件名不能包含子目录", {});
    if (previousVersion)
      await this.writeBytes({ appType: "copy", path: fileName, externalPath: path }, body, previousVersion);
    else {
      // Only a persisted save receipt authorizes updates. An existing file may
      // belong to the user even when its bytes match, or follow an interrupted
      // link-before-receipt commit; neither case grants ownership.
      const temporary = join(
        parent,
        `.atria-save-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
        await handle.close();
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await this.assertFile(path);
          throw new ApplicationError(
            "invalid_operation",
            "目标文件已存在，未覆盖；请选择其他目录或明确保存原文件",
            { path }
          );
        }
      } finally {
        await handle.close();
        // eslint-disable-next-line no-restricted-syntax -- 临时文件在本目录内，删除失败不影响已写入的目标文件
        await unlink(temporary).catch(() => {});
      }
    }
    return path;
  }

  async availablePath(appType: string, desired: string): Promise<string> {
    const base = this.relativePath(desired);
    await this.checkedAccess({ appType, path: base });
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : "";
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const candidate = attempt === 0 ? base : `${stem} ${attempt + 1}${extension}`;
      try {
        await lstat(this.workspacePath(appType, candidate));
      } catch (error) {
        if (missing(error)) return candidate;
        throw error;
      }
    }
    throw new ApplicationError("invalid_operation", "无法为该标题找到可用文件名", { desired });
  }

  async rename(
    resource: ResourceFile,
    desired: string,
    beforeRename?: (target: ResourceFile) => Promise<void>
  ): Promise<ResourceFile> {
    if (desired === resource.path) return resource;
    const source = await this.checkedAccess(resource);
    await this.assertFile(source);
    if (resource.externalPath) {
      // A title change must not silently move the user's file into our workspace.
      const target = checkedExternalPath(join(dirname(source), this.relativePath(desired)));
      try {
        await lstat(target);
        throw new ApplicationError("invalid_operation", "该文件名已存在，请使用其他名称", { path: target });
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const file = { ...resource, path: basename(target), externalPath: target };
      await beforeRename?.(file);
      await rename(source, target);
      return file;
    }
    const path = await this.availablePath(resource.appType, desired);
    const target = this.workspacePath(resource.appType, path);
    await mkdir(dirname(target), { recursive: true });
    const file = { ...resource, path };
    await beforeRename?.(file);
    await rename(source, target);
    return file;
  }

  private async checkedAccess(resource: ResourceFile): Promise<string> {
    const path = this.absolutePath(resource);
    if (resource.externalPath) {
      const actual = checkedExternalPath(join(await realpath(dirname(path)), basename(path)));
      if (actual !== path)
        throw new ApplicationError("unsafe_path", "外部文件的目录已改变，请重新打开文件", { path });
    } else {
      // Reject symlinks in intermediate directories too; checking only the final
      // file lets a workspace directory redirect both reads and atomic writes.
      let current = await realpath(this.workspaceRoot);
      for (const segment of relative(resolve(this.workspaceRoot), dirname(path)).split(sep)) {
        current = join(current, segment);
        try {
          if ((await lstat(current)).isSymbolicLink())
            throw new ApplicationError("unsafe_path", "资源目录不能是符号链接", { path });
        } catch (error) {
          if (missing(error)) break;
          throw error;
        }
      }
    }
    return path;
  }

  private async assertFile(path: string) {
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new ApplicationError("unsafe_path", "资源文件不是普通文件", { path });
      }
      return details;
    } catch (error) {
      if (missing(error))
        throw new ApplicationError("resource_not_found", `资源文件已不存在：${basename(path)}`, { path });
      throw error;
    }
  }
}

function checkedExternalPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/.test(value) || !isAbsolute(value)) {
    throw new ApplicationError("unsafe_path", "外部文件需要合法的绝对路径", { path: value });
  }
  const target = resolve(value);
  const guard = configuredProtectedPaths(dirname(target), process.env, [atriaInstallRoot()]);
  const blocked = guard.match(target);
  if (blocked)
    throw new ApplicationError("unsafe_path", `这个位置受保护，不能作为资源打开：${blocked}`, {
      path: value,
      protected: blocked
    });
  return target;
}

export function deriveFileName(
  definition: { fileExtensions?: Record<string, string> },
  kind: string,
  title: string
): string {
  const extension = definition.fileExtensions?.[kind] ?? "";
  const base =
    title
      .replace(/[\\/]+/g, "-")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\-\s]+/, "")
      .trim()
      .slice(0, 100) || "未命名";
  return !extension || base.toLowerCase().endsWith(extension.toLowerCase()) ? base : `${base}${extension}`;
}
