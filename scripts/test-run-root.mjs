import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Test runs own their temporary directories. A run gets one root under the
 * system temporary directory and points TMPDIR at it, so every `mkdtemp`
 * a test makes, and every isolated backend data root (ATRIA_HOME) inside it,
 * belongs to that run. A backend left alive under the root after the run is a
 * leak (#35): it is stopped and the run fails. Roots left by a runner that was
 * killed outright are swept at the start of the next run.
 */
const PREFIX = "formicand-run-";
const OWNER = "owner.json";

const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
/** Signals a process that may already have exited since it was listed. */
const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
// /var and /private/var name the same macOS directory; match either spelling.
const spellings = (path) => {
  // Once removed, the given spelling is the only one left to match.
  return existsSync(path) ? [...new Set([path, realpathSync(path)])] : [path];
};

/** Backends whose data root lies under `root`, read from each process's environment. */
export async function backendsUnder(root) {
  if (process.platform === "win32") return [];
  const roots = spellings(root).map((path) => `${path}/`);
  const { stdout } = await run("ps", ["axeww", "-o", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) return [];
    const home = /(?:^|\s)ATRIA_HOME=(\S+)/.exec(match[2])?.[1];
    return home && roots.some((prefix) => `${home}/`.startsWith(prefix))
      ? [{ pid: Number(match[1]), home }]
      : [];
  });
}

/** Stops every backend under `root` and returns the ones that were still running. */
export async function stopBackendsUnder(root) {
  const leaked = await backendsUnder(root);
  for (const { pid } of leaked) signal(pid, "SIGTERM");
  for (let waited = 0; waited < 5000 && leaked.some(({ pid }) => alive(pid)); waited += 100) await sleep(100);
  for (const { pid } of leaked) if (alive(pid)) signal(pid, "SIGKILL");
  return leaked;
}

/** Sweeps roots whose runner is gone: a run killed before it could clean up. */
async function sweepAbandoned(parent) {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(PREFIX)) continue;
    const root = join(parent, name);
    const record = join(root, OWNER);
    // A root without an owner is still being created by a starting run.
    if (!existsSync(record)) continue;
    if (alive(JSON.parse(readFileSync(record, "utf8")).pid)) continue;
    const stopped = await stopBackendsUnder(root);
    if (stopped.length)
      console.warn(`Stopped ${stopped.length} backend(s) left by an interrupted test run in ${root}`);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Creates this run's temporary root; pass it to the run as TMPDIR. */
export async function openTestRun(owner = process.pid) {
  const parent = tmpdir();
  await sweepAbandoned(parent);
  const root = mkdtempSync(join(parent, PREFIX));
  writeFileSync(join(root, OWNER), JSON.stringify({ pid: owner }));
  return root;
}

/**
 * Ends the run: stops and reports any backend still alive under its root,
 * then removes the root. Returns the leaked backends.
 */
export async function closeTestRun(root) {
  const leaked = await stopBackendsUnder(root);
  for (const { pid, home } of leaked)
    console.error(`Leaked backend ${pid} (ATRIA_HOME=${home}): the test that started it must stop it.`);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return leaked;
}
