import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { readTaskInput, type InputFile } from "./input-store.js";
const execute = promisify(execFile);
type Options = {
  offset?: number;
  limit?: number;
  page?: number;
  render?: boolean;
  supportsImages?: boolean;
  harnessRoot?: string;
};
export interface InputDocument {
  file: InputFile;
  absolutePath: string;
  text?: string;
  image?: string;
  mimeType?: string;
  nextOffset?: number | null;
  offset?: number;
  page?: number;
  pages?: number;
}

export async function readInputDocument(
  taskRoot: string,
  uploadId: string,
  options: Options = {}
): Promise<InputDocument> {
  return readStoredDocument(await readTaskInput(taskRoot, uploadId), options);
}
export async function readStoredDocument(
  input: { file: InputFile; bytes: Buffer; absolutePath: string },
  options: Options = {}
): Promise<InputDocument> {
  const { file, bytes, absolutePath } = input;
  const offset = Math.max(0, Math.floor(options.offset || 0)),
    limit = Math.max(1, Math.min(20000, Math.floor(options.limit || 12000)));
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) throw new Error("读取范围不合法");
  if (file.kind === "image") {
    if (!options.supportsImages)
      throw new Error("当前模型不支持图片输入；文件已保留，可切换支持图片的模型后读取");
    return { file, absolutePath, image: bytes.toString("base64"), mimeType: file.mimeType };
  }
  if (file.kind === "text") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      file,
      absolutePath,
      text: text.slice(offset, offset + limit),
      offset,
      nextOffset: offset + limit < text.length ? offset + limit : null
    };
  }
  if (options.render && !options.supportsImages) throw new Error("当前模型不支持图片输入；可先读取PDF文字");
  const page = Math.max(0, Math.floor(options.page || (options.render ? 1 : 0)));
  if (!Number.isFinite(page)) throw new Error("页码不合法");
  try {
    const { stdout } = await execute(
      process.env.COWORK_PYTHON || "python3",
      [
        join(
          resolve(options.harnessRoot || process.env.COWORK_HARNESS_ROOT || process.cwd()),
          "scripts",
          "read-attachment.py"
        ),
        absolutePath,
        String(offset),
        String(limit),
        String(page),
        options.render ? "1" : "0"
      ],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }
    );
    return { ...JSON.parse(stdout), file, absolutePath } as {
      file: typeof file;
      absolutePath: string;
      text?: string;
      image?: string;
      mimeType?: string;
      nextOffset?: number | null;
    };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) {
      try {
        throw new Error((JSON.parse(stdout) as { error: string }).error);
      } catch (parsed) {
        if (parsed instanceof SyntaxError) throw new Error("文档解析器返回无效结果，原文件已保留");
        throw parsed;
      }
    }
    throw new Error("文档解析工具不可用或读取超时，原文件已保留。请检查本地Python与PDF/Office解析依赖。");
  }
}
