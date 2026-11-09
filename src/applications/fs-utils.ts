import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable small-file writes for the application stores.
 *
 * One implementation on purpose. There were three copies, and the third had
 * drifted: no random suffix, so two writes in the same millisecond collided,
 * and no `sync()`, so a crash could leave a valid rename pointing at an empty
 * file — exactly what the other two carried a comment explaining they prevent.
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  options?: { mode?: number; exclusive?: boolean }
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await open(temporary, "wx", options?.mode);
  try {
    if (options?.mode !== undefined) await handle.chmod(options.mode);
    await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
    // The rename is atomic, but only over bytes the kernel has committed.
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options?.exclusive) {
    try {
      await link(temporary, path);
    } finally {
      await unlink(temporary);
    }
  } else await rename(temporary, path);
}

/** Append one line and flush it, so a reported success survives a crash. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** JSONL: one record per line, so a torn tail loses one entry rather than all. */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
