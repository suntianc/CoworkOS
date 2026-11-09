import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const PREVIEW_MARKER = Buffer.from("\n...[output truncated]...\n");

export interface ForegroundOutputSettings {
  maxOutputBytes: number;
  previewBytes?: number;
  outputLogDirectory?: string;
}

export interface ForegroundOutputReceipt {
  stdout: string;
  stderr: string;
  stdoutPath?: string;
  stderrPath?: string;
  /** Raw bytes observed on each pipe, including bytes beyond its hard limit. */
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLogBytes: number;
  stderrLogBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  logLimitExceeded?: boolean;
}

/** Owns backpressure, bounded previews and the two per-command log handles. */
export class ForegroundCommandOutput {
  private constructor(
    private readonly stdout: OutputStream,
    private readonly stderr: OutputStream
  ) {}

  static async create(settings: ForegroundOutputSettings): Promise<ForegroundCommandOutput> {
    if (!Number.isSafeInteger(settings.maxOutputBytes) || settings.maxOutputBytes < 1)
      throw new Error("maxOutputBytes must be a positive safe integer");
    if (
      settings.previewBytes !== undefined &&
      (!Number.isSafeInteger(settings.previewBytes) || settings.previewBytes < 0)
    )
      throw new Error("previewBytes must be a non-negative safe integer");
    let directory: string | undefined;
    let stdout: FileHandle | undefined;
    let stderr: FileHandle | undefined;
    try {
      if (settings.outputLogDirectory !== undefined) {
        const root = resolve(settings.outputLogDirectory);
        await privateLogRoot(root);
        directory = join(root, randomUUID());
        await mkdir(directory, { mode: 0o700 });
        // Reject a substituted parent before opening any log for writing.
        if ((await realpath(directory)) !== directory)
          throw new Error("Foreground output log directory contains a symbolic link");
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- O_NOFOLLOW 是 POSIX 打开标志，Windows 等平台的 fs.constants 可能缺失，需要 0 兜底
        const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
        stdout = await open(join(directory, "stdout.log"), flags, 0o600);
        stderr = await open(join(directory, "stderr.log"), flags, 0o600);
      }
      return new ForegroundCommandOutput(
        new OutputStream("stdout", settings, stdout, directory && join(directory, "stdout.log")),
        new OutputStream("stderr", settings, stderr, directory && join(directory, "stderr.log"))
      );
    } catch (cause) {
      await Promise.allSettled([stdout?.close(), stderr?.close()]);
      // eslint-disable-next-line no-restricted-syntax -- 正在上抛日志初始化错误，清理临时目录失败不应覆盖原始失败原因
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Foreground command output log setup failed: ${String(cause)}`, { cause });
    }
  }

  async consume(
    name: "stdout" | "stderr",
    source: Readable | null,
    failed: (error: Error) => void
  ): Promise<void> {
    if (!source) return;
    const output = this[name];
    try {
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
        const exceeded = await output.collect(chunk);
        if (exceeded) failed(new Error(`${name} maxBuffer length exceeded (output log hard limit)`));
      }
    } catch (cause) {
      failed(new Error(`Foreground command ${name} output log write failed`, { cause }));
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([this.stdout.close(), this.stderr.close()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      throw new Error("Foreground command output log flush/close failed", { cause: failed.reason });
  }

  receipt(): ForegroundOutputReceipt {
    return {
      stdout: this.stdout.text(),
      stderr: this.stderr.text(),
      ...(this.stdout.path ? { stdoutPath: this.stdout.path } : {}),
      ...(this.stderr.path ? { stderrPath: this.stderr.path } : {}),
      stdoutBytes: this.stdout.observedBytes,
      stderrBytes: this.stderr.observedBytes,
      stdoutLogBytes: this.stdout.logBytes,
      stderrLogBytes: this.stderr.logBytes,
      stdoutTruncated: this.stdout.truncated,
      stderrTruncated: this.stderr.truncated,
      ...(this.stdout.limitExceeded || this.stderr.limitExceeded ? { logLimitExceeded: true } : {})
    };
  }
}

class OutputStream {
  observedBytes = 0;
  logBytes = 0;
  limitExceeded = false;
  private capturedBytes = 0;
  private chunks: Buffer[] = [];
  private head?: Buffer;
  private tail?: Buffer;
  private clipped = false;
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly settings: ForegroundOutputSettings,
    private readonly file?: FileHandle,
    readonly path?: string
  ) {}

  get truncated(): boolean {
    return this.clipped || this.observedBytes > this.capturedBytes;
  }

  async collect(chunk: Buffer): Promise<boolean> {
    this.observedBytes += chunk.length;
    const room = Math.max(0, this.settings.maxOutputBytes - this.capturedBytes);
    const kept = chunk.subarray(0, room);
    this.capturedBytes += kept.length;
    this.limitExceeded ||= chunk.length > room;
    if (kept.length) {
      this.preview(kept);
      if (this.file) {
        let offset = 0;
        while (offset < kept.length) {
          const { bytesWritten } = await this.file.write(kept, offset, kept.length - offset, null);
          if (!bytesWritten) throw new Error(`${this.name} output log write made no progress`);
          offset += bytesWritten;
          this.logBytes += bytesWritten;
        }
      }
    }
    return this.limitExceeded;
  }

  private preview(chunk: Buffer): void {
    const budget = this.settings.previewBytes;
    if (budget === undefined) {
      this.chunks.push(Buffer.from(chunk));
      return;
    }
    if (!this.clipped && this.capturedBytes <= budget) {
      this.chunks.push(Buffer.from(chunk));
      return;
    }
    const available = Math.max(0, budget - PREVIEW_MARKER.length);
    const headBytes = Math.floor(available / 2);
    const tailBytes = available - headBytes;
    if (!this.clipped) {
      const earlier = Buffer.concat(this.chunks);
      this.chunks = [];
      const missingHead = Math.max(0, headBytes - earlier.length);
      this.head = Buffer.concat([earlier.subarray(0, headBytes), chunk.subarray(0, missingHead)]);
      this.tail = tailBytes
        ? Buffer.from(Buffer.concat([earlier.subarray(-tailBytes), chunk]).subarray(-tailBytes))
        : Buffer.alloc(0);
      this.clipped = true;
    } else if (tailBytes) {
      this.tail =
        chunk.length >= tailBytes
          ? Buffer.from(chunk.subarray(-tailBytes))
          : Buffer.concat([this.tail!.subarray(-(tailBytes - chunk.length)), chunk]);
    }
  }

  text(): string {
    const budget = this.settings.previewBytes ?? this.settings.maxOutputBytes;
    if (!this.clipped) return decodePrefix(Buffer.concat(this.chunks), budget);
    if (budget <= PREVIEW_MARKER.length) return PREVIEW_MARKER.subarray(0, budget).toString();
    const head = decodePrefix(this.head!, this.head!.length);
    const tail = this.tail!;
    return head + PREVIEW_MARKER.toString() + decodeTail(tail, tail.length);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.file) return;
    try {
      await this.file.sync();
    } finally {
      await this.file.close();
    }
  }
}

/** Decode complete UTF-8 codepoints and bound replacements for invalid input too. */
function decodePrefix(bytes: Buffer, budget: number): string {
  const text = new StringDecoder("utf8").write(bytes);
  const encoded = Buffer.from(text);
  return encoded.length <= budget ? text : new StringDecoder("utf8").write(encoded.subarray(0, budget));
}

function decodeTail(bytes: Buffer, budget: number): string {
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const text = new StringDecoder("utf8").write(bytes.subarray(start));
  const encoded = Buffer.from(text);
  if (encoded.length <= budget) return text;
  const tail = encoded.subarray(-budget);
  let boundary = 0;
  while (boundary < tail.length && (tail[boundary] & 0xc0) === 0x80) boundary++;
  return new StringDecoder("utf8").write(tail.subarray(boundary));
}

async function privateLogRoot(directory: string): Promise<void> {
  let current = parse(directory).root;
  for (const component of directory.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Foreground output log path contains a symbolic link");
    if (!info.isDirectory()) throw new Error("Foreground output log path is not a directory");
  }
}
