import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, rename, rm, realpath } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Readable } from "node:stream";
import { withFileLock } from "../storage/file-lock.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 10;
const formats: Record<string, [string, string] | undefined> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  webp: ["image", "image/webp"],
  gif: ["image", "image/gif"],
  pdf: ["pdf", "application/pdf"],
  docx: ["office", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  pptx: ["office", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  xlsx: ["office", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
};
const textExtensions =
  /^(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|log|ini|toml|tex|svg)$/;
export interface InputFile {
  uploadId: string;
  name: string;
  size: number;
  mimeType: string;
  kind: string;
  sha256: string;
  createdAt: string;
  relativePath: string;
}
function safeId(value: string) {
  if (!/^upload-[a-f0-9-]{36}$/.test(value)) throw new Error("附件标识不合法");
  return value;
}
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("附件目录不安全");
  return path;
}
async function regular(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();
  if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) {
    await handle.close();
    throw new Error("附件文件不合法");
  }
  return handle;
}
async function metadata(root: string, uploadId: string): Promise<InputFile> {
  const folder = join(root, safeId(uploadId));
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("附件目录不安全");
  const handle = await regular(join(folder, "metadata.json"));
  try {
    const file = JSON.parse(await handle.readFile("utf8")) as InputFile;
    if (
      !file.name ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.uploadId !== uploadId ||
      !/^original\.[a-z]+$/.test(file.relativePath) ||
      !Number.isSafeInteger(file.size) ||
      file.size > MAX_UPLOAD_BYTES
    )
      throw new Error("附件记录不合法");
    return file;
  } finally {
    await handle.close();
  }
}
function validateSignature(extension: string, head: Buffer) {
  const valid =
    extension === "png"
      ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : /jpe?g/.test(extension)
        ? head[0] === 255 && head[1] === 216 && head[2] === 255
        : extension === "gif"
          ? /^GIF8[79]a/.test(head.toString("ascii", 0, 6))
          : extension === "webp"
            ? head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP"
            : extension === "pdf"
              ? head.toString("ascii", 0, 5) === "%PDF-"
              : /^(docx|pptx|xlsx)$/.test(extension)
                ? head[0] === 80 && head[1] === 75 && head[2] === 3 && head[3] === 4
                : true;
  if (!valid) throw new Error("文件内容与扩展名不一致，未添加");
}
export class InputStore {
  constructor(private readonly root: string) {}
  async receive(name: string, stream: Readable): Promise<InputFile> {
    if (!name || name.length > 240 || name !== basename(name) || /[\\/\0\r\n]/.test(name))
      throw new Error("文件名不合法");
    const extension = extname(name).slice(1).toLowerCase();
    const format =
      formats[extension] ??
      (textExtensions.test(extension) ? ["text", "text/plain; charset=utf-8"] : undefined);
    if (!format) throw new Error("暂不支持此格式，请添加图片、PDF、DOCX、PPTX、XLSX或文本文件");
    await directory(this.root);
    const uploadId = `upload-${randomUUID()}`;
    const folder = await directory(join(this.root, uploadId));
    const relativePath = `original.${extension}`;
    const handle = await open(join(folder, relativePath), "wx", 0o600);
    let size = 0,
      head = Buffer.alloc(0);
    const hash = createHash("sha256");
    const decoder = format[0] === "text" ? new TextDecoder("utf-8", { fatal: true }) : undefined;
    try {
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new Error("文件超过25 MB，未添加");
        if (head.length < 1024) head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
        if (decoder) {
          const text = decoder.decode(chunk, { stream: true });
          if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error("文本文件包含二进制字符");
        }
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      decoder?.decode();
      validateSignature(extension, head);
      const file: InputFile = {
        uploadId,
        name,
        size,
        mimeType: format[1],
        kind: format[0],
        sha256: hash.digest("hex"),
        createdAt: new Date().toISOString(),
        relativePath
      };
      await handle.close();
      const meta = await open(join(folder, "metadata.json"), "wx", 0o600);
      try {
        await meta.writeFile(JSON.stringify(file));
      } finally {
        await meta.close();
      }
      return file;
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- 写入失败后的关闭只是清理半成品，主错误仍需向上抛出
      await handle.close().catch(() => {});
      await rm(folder, { recursive: true, force: true });
      if (error instanceof TypeError) throw new Error("文件不是有效 UTF-8 文本，未添加");
      throw error;
    }
  }
  async read(uploadId: string) {
    const file = await metadata(this.root, uploadId);
    const handle = await regular(join(this.root, file.uploadId, file.relativePath));
    try {
      const bytes = await handle.readFile();
      if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error("原始附件已发生变化，请重新添加");
      return { file, bytes, absolutePath: join(this.root, file.uploadId, file.relativePath) };
    } finally {
      await handle.close();
    }
  }
  async attach(workspaceRoot: string, taskId: string, ids: unknown): Promise<InputFile[]> {
    if (ids === undefined || (Array.isArray(ids) && !ids.length)) return [];
    if (!Array.isArray(ids) || ids.length > MAX_MESSAGE_FILES || ids.some((id) => typeof id !== "string"))
      throw new Error("每条消息最多添加10个附件");
    if (taskId === "." || taskId === ".." || !/^[a-zA-Z0-9._-]+$/.test(taskId))
      throw new Error("任务标识不合法");
    const taskRoot = join(await realpath(workspaceRoot), taskId);
    const info = await lstat(taskRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("任务目录不安全");
    const root = await directory(join(taskRoot, "inputs"));
    return withFileLock(join(root, "manifest.json"), async () => {
      const result: InputFile[] = [];
      const sources = [];
      let total = 0;
      for (const id of [...new Set(ids as string[])]) {
        const source = await this.read(id);
        total += source.bytes.length;
        if (total > 100 * 1024 * 1024) throw new Error("附件合计超过100 MB");
        sources.push(source);
      }
      for (const { file, bytes } of sources) {
        const folder = await directory(join(root, file.uploadId));
        const temporary = join(folder, `.upload-${randomUUID()}`);
        const writer = await open(temporary, "wx", 0o600);
        try {
          await writer.writeFile(bytes);
        } finally {
          await writer.close();
        }
        await rename(temporary, join(folder, file.relativePath));
        const meta = await open(
          join(folder, "metadata.json"),
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o600
        );
        try {
          await meta.writeFile(JSON.stringify(file));
        } finally {
          await meta.close();
        }
        result.push(file);
      }
      return result;
    });
  }
}
export async function readTaskInput(taskRoot: string, uploadId: string) {
  const task = await lstat(taskRoot);
  if (!task.isDirectory() || task.isSymbolicLink()) throw new Error("任务目录不安全");
  const root = join(await realpath(taskRoot), "inputs");
  const dir = await lstat(root);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("附件目录不安全");
  const file = await metadata(root, uploadId);
  const absolutePath = join(root, file.uploadId, file.relativePath);
  const handle = await regular(absolutePath);
  try {
    const bytes = await handle.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error("原始附件已发生变化，请重新添加");
    return { file, bytes, absolutePath };
  } finally {
    await handle.close();
  }
}
export function inputPrompt(taskRoot: string, files: InputFile[]) {
  if (!files.length) return "";
  return (
    "\n\n<atria_uploaded_files>\n" +
    JSON.stringify({
      version: 1,
      files: files.map((f) => ({ ...f, path: join(taskRoot, "inputs", f.uploadId, f.relativePath) }))
    }) +
    "\n</atria_uploaded_files>"
  );
}
