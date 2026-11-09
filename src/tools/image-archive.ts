import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { containsFilePath } from "./file-path.js";
import {
  assertImageActive,
  DEFAULT_MAX_IMAGE_BYTES,
  inspectImage,
  MAX_IMAGE_PIXELS,
  type ImageMimeType
} from "./image-data.js";

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ImageMapping {
  sourceImageRef: string;
  sourceWidth: number;
  sourceHeight: number;
  region: ImageRegion;
  scaleX: number;
  scaleY: number;
}
export interface ImageSource {
  kind: "file" | "computer" | "browser" | "derived";
  label?: string;
  /** Historical provenance only; never a current action credential. */
  sourceObservationId?: string;
  historical?: true;
}
export interface ImageRecord {
  version: 1;
  imageRef: string;
  imageHash: string;
  mimeType: ImageMimeType;
  bytes: number;
  createdAt: string;
  width?: number;
  height?: number;
  source?: ImageSource;
  mapping?: ImageMapping;
}
export interface ImageArchiveOptions {
  taskDirectory: string;
  maxImageBytes?: number;
  maxArchiveBytes?: number;
  maxRecords?: number;
}
const REF = /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 4096;
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function validateSource(source?: ImageSource): ImageSource | undefined {
  if (source === undefined) return undefined;
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source 来自磁盘上的 image 记录 JSON 或工具参数，可能是 null 而声明类型只覆盖 undefined
    !source ||
    !["file", "computer", "browser", "derived"].includes(source.kind) ||
    (source.label !== undefined && (typeof source.label !== "string" || source.label.length > 512)) ||
    (source.sourceObservationId !== undefined &&
      (typeof source.sourceObservationId !== "string" || source.sourceObservationId.length > 200)) ||
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 记录 JSON 里的 historical 可能是 false 或字符串，声明类型只允许字面量 true
    (source.historical !== undefined && source.historical !== true)
  )
    throw new Error("Invalid historical image source");
  return {
    kind: source.kind,
    ...(source.label === undefined ? {} : { label: source.label }),
    ...(source.sourceObservationId === undefined ? {} : { sourceObservationId: source.sourceObservationId }),
    historical: true
  };
}
function validateMapping(mapping?: ImageMapping): ImageMapping | undefined {
  if (mapping === undefined) return undefined;
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mapping 来自磁盘上的 image 记录 JSON，损坏记录里可能是 null
    !mapping ||
    !REF.test(mapping.sourceImageRef) ||
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 记录 JSON 里的 region 可能缺失或不是对象，索引前必须校验
    !mapping.region ||
    ![mapping.sourceWidth, mapping.sourceHeight, mapping.region.width, mapping.region.height].every(
      (value) => Number.isSafeInteger(value) && value > 0
    ) ||
    ![mapping.region.x, mapping.region.y].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    mapping.region.x + mapping.region.width > mapping.sourceWidth ||
    mapping.region.y + mapping.region.height > mapping.sourceHeight ||
    ![mapping.scaleX, mapping.scaleY].every((value) => Number.isFinite(value) && value > 0 && value <= 8)
  )
    throw new Error("Invalid image coordinate mapping");
  return {
    sourceImageRef: mapping.sourceImageRef,
    sourceWidth: mapping.sourceWidth,
    sourceHeight: mapping.sourceHeight,
    region: {
      x: mapping.region.x,
      y: mapping.region.y,
      width: mapping.region.width,
      height: mapping.region.height
    },
    scaleX: mapping.scaleX,
    scaleY: mapping.scaleY
  };
}

/** Immutable Task-local pixels. References are evidence, never desktop action authority. */
export function createImageArchive(options: ImageArchiveOptions) {
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxArchiveBytes = options.maxArchiveBytes ?? 512 * 1024 * 1024;
  const maxRecords = options.maxRecords ?? 1024;
  if (
    ![maxImageBytes, maxArchiveBytes, maxRecords].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Invalid image archive limits");
  async function locked<T>(path: string, signal: AbortSignal | undefined, operation: () => Promise<T>) {
    try {
      return await withFileLock(
        join(path, "archive"),
        async () => {
          assertImageActive(signal);
          return operation();
        },
        { timeoutMs: 1000, recoverDeadOwner: true }
      );
    } catch (error) {
      assertImageActive(signal);
      throw error;
    }
  }
  async function directory(create: boolean) {
    const root = await realpath(options.taskDirectory);
    let path = root;
    for (const part of ["visual", "images"]) {
      path = join(path, part);
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || !containsFilePath(root, await realpath(path)))
        throw new Error("Image archive path escapes its Task or is not a directory");
    }
    try {
      const lock = await lstat(join(path, "archive.lock"));
      if (!lock.isDirectory() || lock.isSymbolicLink()) throw new Error("Invalid image archive lock path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return path;
  }
  async function boundedRead(path: string, limit: number, signal?: AbortSignal) {
    assertImageActive(signal);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) throw new Error("Image archive file exceeds its limit");
      // Use a bounded allocation even if the file is replaced or grows after stat.
      const data = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let offset = 0;
      while (offset < data.length) {
        assertImageActive(signal);
        const result = await handle.read(data, offset, data.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset > limit || offset > info.size) throw new Error("Image archive file changed while reading");
      assertImageActive(signal);
      return data.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }
  async function entries(path: string, signal?: AbortSignal) {
    const found: string[] = [];
    const stream = await opendir(path);
    for await (const entry of stream) {
      assertImageActive(signal);
      if (entry.name === "archive.lock") {
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new Error("Invalid image archive lock path");
        continue;
      }
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^img_[0-9a-f-]+\.(data|json|pending)$/.test(entry.name)
      )
        throw new Error("Invalid image archive entry");
      if (!REF.test(entry.name.replace(/\.(data|json|pending)$/, "")))
        throw new Error("Invalid image archive entry");
      found.push(entry.name);
      if (found.length > maxRecords * 3) throw new Error("Image archive record limit reached");
    }
    return found;
  }
  async function readRecord(path: string, imageRef: string, signal?: AbortSignal): Promise<ImageRecord> {
    if (!REF.test(imageRef)) throw new Error("Invalid imageRef; use a Task image reference");
    let record: ImageRecord;
    try {
      record = JSON.parse(
        (await boundedRead(join(path, `${imageRef}.json`), MAX_RECORD_BYTES, signal)).toString()
      );
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Corrupt image record: ${imageRef}`);
      throw error;
    }
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- record 由 JSON.parse 得到，被截断或改写过的记录文件可能解析出 null
      !record ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 磁盘上的记录文件可能来自其它版本，version 运行期不保证为 1
      record.version !== 1 ||
      record.imageRef !== imageRef ||
      !/^[0-9a-f]{64}$/.test(record.imageHash) ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(record.mimeType) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > maxImageBytes ||
      typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      (record.width !== undefined && (!Number.isSafeInteger(record.width) || record.width < 1)) ||
      (record.height !== undefined && (!Number.isSafeInteger(record.height) || record.height < 1)) ||
      (record.mimeType === "image/png" &&
        (!record.width || !record.height || record.width * record.height > MAX_IMAGE_PIXELS))
    )
      throw new Error(`Corrupt image record: ${imageRef}`);
    const source = validateSource(record.source),
      mapping = validateMapping(record.mapping);
    return {
      version: 1,
      imageRef,
      imageHash: record.imageHash,
      mimeType: record.mimeType,
      bytes: record.bytes,
      createdAt: record.createdAt,
      ...(record.width === undefined ? {} : { width: record.width }),
      ...(record.height === undefined ? {} : { height: record.height }),
      ...(source ? { source } : {}),
      ...(mapping ? { mapping } : {})
    };
  }
  return {
    async put(input: {
      data: Buffer;
      mimeType: ImageMimeType;
      source?: ImageSource;
      mapping?: ImageMapping;
      signal?: AbortSignal;
    }): Promise<ImageRecord> {
      assertImageActive(input.signal);
      const dimensions = inspectImage(input.data, input.mimeType, maxImageBytes);
      const data = Buffer.from(input.data);
      const source = validateSource(input.source),
        mapping = validateMapping(input.mapping);
      const path = await directory(true);
      return locked(path, input.signal, async () => {
        assertImageActive(input.signal);
        await directory(false);
        const files = await entries(path, input.signal);
        const refs = new Set(files.map((file) => file.replace(/\.(data|json|pending)$/, "")));
        if (refs.size >= maxRecords) throw new Error("Image archive record limit reached");
        let total = 0;
        for (const file of files) {
          assertImageActive(input.signal);
          const info = await lstat(join(path, file));
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid image archive entry");
          total += info.size;
        }
        const record: ImageRecord = {
          version: 1,
          imageRef: `img_${randomUUID()}`,
          imageHash: hash(data),
          mimeType: input.mimeType,
          bytes: data.length,
          createdAt: new Date().toISOString(),
          ...dimensions,
          ...(source ? { source } : {}),
          ...(mapping ? { mapping } : {})
        };
        const metadata = JSON.stringify(record);
        if (Buffer.byteLength(metadata) > MAX_RECORD_BYTES)
          throw new Error("Image metadata exceeds its limit");
        if (total + data.length + Buffer.byteLength(metadata) > maxArchiveBytes)
          throw new Error("Image archive byte limit reached; existing images were preserved");
        const bodyPath = join(path, `${record.imageRef}.data`),
          recordPath = join(path, `${record.imageRef}.json`),
          pendingPath = join(path, `${record.imageRef}.pending`);
        const created: string[] = [];
        async function writeNew(file: string, data: Buffer | string) {
          const handle = await open(file, "wx", 0o600);
          created.push(file);
          try {
            await handle.writeFile(data, { signal: input.signal });
          } finally {
            await handle.close();
          }
        }
        try {
          await writeNew(bodyPath, data);
          assertImageActive(input.signal);
          await writeNew(pendingPath, metadata);
          assertImageActive(input.signal);
          // Atomic, exclusive publication after bytes and metadata are complete.
          // A crash's .pending file remains budgeted but never becomes a record.
          await link(pendingPath, recordPath);
          // eslint-disable-next-line no-restricted-syntax -- 记录已原子发布，.pending 只是中间文件，删除失败不影响已提交的 imageRef
          await unlink(pendingPath).catch(() => {});
          return record;
        } catch (error) {
          // eslint-disable-next-line no-restricted-syntax -- 正在上抛写入失败，逐个清理已创建文件是 best-effort，清理失败不应覆盖原始错误
          await Promise.all(created.map((file) => unlink(file).catch(() => {})));
          throw error;
        }
      });
    },
    async read(imageRef: string, signal?: AbortSignal) {
      assertImageActive(signal);
      if (typeof imageRef !== "string" || !REF.test(imageRef))
        throw new Error("Invalid imageRef; use a Task image reference");
      const path = await directory(false);
      const record = await readRecord(path, imageRef, signal);
      const data = await boundedRead(join(path, `${imageRef}.data`), maxImageBytes, signal);
      const dimensions = inspectImage(data, record.mimeType, maxImageBytes);
      if (
        data.length !== record.bytes ||
        hash(data) !== record.imageHash ||
        dimensions.width !== record.width ||
        dimensions.height !== record.height
      )
        throw new Error(`Archived image integrity check failed: ${imageRef}`);
      return { record, data };
    },
    async list(input: { limit?: number; signal?: AbortSignal } = {}) {
      assertImageActive(input.signal);
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        throw new Error("Image history limit must be 1–50");
      let path: string;
      try {
        path = await directory(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      // Read only committed records; an interrupted write's bytes still count toward the budget.
      return locked(path, input.signal, async () => {
        await directory(false);
        const records: ImageRecord[] = [];
        for (const file of await entries(path, input.signal)) {
          if (file.endsWith(".json")) records.push(await readRecord(path, file.slice(0, -5), input.signal));
        }
        return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      });
    }
  };
}
