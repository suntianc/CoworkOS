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
