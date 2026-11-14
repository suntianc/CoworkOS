import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable small-file writes for runtime state.
 *
 * One implementation on purpose: the temporary name carries a process id,
 * timestamp and random suffix, and the bytes are synced before the rename, so
 * two writes in the same millisecond cannot collide and a crash cannot leave a
 * valid rename pointing at an empty file.
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

/**
 * The same guarantee for a caller that cannot await.
 *
 * A synchronous constructor (for example the local access policy, which must
 * publish a credential before it serves its first request) still gets the
 * temp-file-then-rename write: a crash mid-write leaves the previous file, and
 * a tear can never publish a half-written credential.
 */
export function atomicWriteSync(
  path: string,
  content: string,
  options?: { mode?: number }
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const descriptor = openSync(temporary, "wx", options?.mode);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  // The mode is set at creation, before any byte is written.
  renameSync(temporary, path);
}
