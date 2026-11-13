import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** Stop a watch and release its OS handles. */
export type StopWatching = () => void;

export interface FileWatchOptions {
  /** Coalesce the burst of events one atomic write produces. */
  debounceMs?: number;
  /**
   * How long to wait for the OS to start delivering on the new watch.
   *
   * `watch()` returns before the kernel-side watch is receiving events on
   * macOS. A change made inside that window is invisible to the watcher, so the
   * caller must not rely on events until it has passed. A caller's first read
   * after this resolves still sees anything that changed meanwhile.
   */
  startupMs?: number;
}

/**
 * Call `onChange` when one of `paths` is replaced or rewritten, without polling.
 *
 * Runtime state is written by renaming a temporary file over the target, which
 * replaces the watched inode. Watching the containing directory instead of the
 * file keeps the watch alive across those writes; the event's file name selects
 * which target changed. The directory is created first so the watch can be
 * attached before the first write.
 */
export async function watchFiles(
  paths: readonly string[],
  onChange: () => void,
  options: FileWatchOptions = {}
): Promise<StopWatching> {
  const targets = new Map<string, Set<string>>();
  for (const path of paths) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const names = targets.get(directory) ?? new Set<string>();
    names.add(basename(path));
    targets.set(directory, names);
  }
  const debounceMs = Math.max(10, options.debounceMs ?? 25);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
  };
  const watchers: FSWatcher[] = [];
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };
  try {
    for (const [directory, names] of targets) {
      // `persistent: false`: a watcher must never be the reason a one-shot Pi
      // process stays alive after its last turn.
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (!filename || names.has(filename.toString())) notify();
      });
      watcher.on("error", () => {
        // The directory went away or the OS dropped this watch. The waiter's
        // own deadline still ends the wait; there is no target left to watch.
      });
      watchers.push(watcher);
    }
  } catch (error) {
    stop();
    throw error;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, options.startupMs ?? 100)));
  return stop;
}
