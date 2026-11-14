import { statSync, watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Stop a watch and release its OS handles. */
export type StopWatching = () => void;

export interface FileWatchOptions {
  /** Coalesce the burst of events one atomic write produces. */
  debounceMs?: number;
}

/**
 * Call `onChange` when one of `paths` is replaced or rewritten, without polling.
 *
 * Runtime state is written by renaming a temporary file over the target, which
 * replaces the watched inode. The containing directory is what is watched, so
 * the watch survives those writes. The event's file name is not trusted: macOS
 * coalesces a burst in one directory into an event that may name another entry,
 * so every event re-reads each watched file's identity and only a real change
 * is reported.
 *
 * The caller reads the current state once after this resolves. A write that
 * raced the OS watch registration is seen by that read; every later write
 * arrives as an event whose identity check reports it.
 */
export async function watchFiles(
  paths: readonly string[],
  onChange: () => void,
  options: FileWatchOptions = {}
): Promise<StopWatching> {
  // A test that has to show delivery does not depend on OS file events runs the
  // process with this set: the watch never attaches, so everything that still
  // arrives came from the writer's own wake notification.
  if (process.env.COWORK_DISABLE_FILE_WATCH === "1") return () => {};
  const directories = new Map<string, Map<string, string>>();
  for (const path of paths) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const targets = directories.get(directory) ?? new Map<string, string>();
    // Snapshot before attaching: a change after this point differs from the
    // snapshot even when its event was lost to the registration window, so the
    // next event still reports it.
    targets.set(path, fileSignature(path));
    directories.set(directory, targets);
  }
  const debounceMs = Math.max(10, options.debounceMs ?? 25);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const watchers: FSWatcher[] = [];

  const check = () => {
    let changed = false;
    for (const targets of directories.values()) {
      for (const [path, previous] of targets) {
        const current = fileSignature(path);
        if (current === previous) continue;
        targets.set(path, current);
        changed = true;
      }
    }
    if (changed && !stopped) onChange();
  };
  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      // A timer callback cannot await without leaving the notification to a
      // floating promise; the check is a couple of local stats, so it runs synchronously.
      check();
    }, debounceMs);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };

  try {
    for (const directory of directories.keys()) {
      // `persistent: false`: a watcher must never be the reason a one-shot Pi
      // process stays alive after its last turn.
      const watcher = watch(directory, { persistent: false }, () => schedule());
      watcher.on("error", () => {
        // The directory went away or the OS dropped this watch. The caller's
        // own deadline still ends the wait; there is nothing left to watch.
      });
      watchers.push(watcher);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

/**
 * The identity of the watched file, including its inode.
 *
 * An atomic write renames a new file over the old one, so comparing content or
 * size alone could miss a same-size rewrite. An unreadable target yields a
 * stable value that differs from any real file, which reports it as a change.
 */
function fileSignature(path: string): string {
  try {
    const value = statSync(path);
    return `${value.dev}:${value.ino}:${value.mtimeMs}:${value.size}`;
  } catch (error) {
    return `unreadable:${error instanceof Error ? error.message : String(error)}`;
  }
}
