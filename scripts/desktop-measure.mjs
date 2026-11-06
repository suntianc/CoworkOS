import { _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Measure one packaged desktop build the same way every time.
 *
 * The comparison P2-06 needs is between builds, so the harness owns the whole
 * condition: a fresh copy of the same data root, an isolated home, the same
 * launch arguments and the same phases. A window counts as ready when its page
 * reports a complete document with the app frame visible. Client and backend
 * processes are reported separately because the backend is the part the
 * architecture changes.
 *
 * Phases: cold start, settled idle, background (window hidden), and reopening a
 * closed window. Peak client memory covers the start-up ramp; settled values are
 * sampled from two process-table snapshots. Nothing here reads user data or
 * credentials: the template is supplied by the caller and copied per run.
 */

const exec = promisify(execFile);

const HELP = `Package measurement for desktop release comparisons
  node scripts/desktop-measure.mjs --app <CoworkOS.app> --template <data root> --out <dir> [options]
  --label NAME       Condition name used in file names (default: build)
  --runs N           Launches to sample (default 3)
  --timeout MS       Launch/window readiness timeout (default 120000)
  --settle MS        Idle time before the settled sample (default 30000)
  --background MS    Wait after hiding the window (default 10000)
  --reopen MS        Wait after reopening a closed window (default 15000)
  --cpu-window MS    Window between the two CPU snapshots (default 5000)
The template data root is copied for each run; it is never written by the harness.`;

function parseOptions(args) {
  const options = {
    runs: 3,
    timeout: 120_000,
    settle: 30_000,
    background: 10_000,
    reopen: 15_000,
    cpuWindow: 5_000,
    label: "build"
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[++index];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === "--app") options.app = value();
    else if (argument === "--template") options.template = value();
    else if (argument === "--out") options.out = value();
    else if (argument === "--label") options.label = value();
    else if (argument === "--runs") options.runs = Number(value());
    else if (argument === "--timeout") options.timeout = Number(value());
    else if (argument === "--settle") options.settle = Number(value());
    else if (argument === "--background") options.background = Number(value());
    else if (argument === "--reopen") options.reopen = Number(value());
    else if (argument === "--cpu-window") options.cpuWindow = Number(value());
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.help && (!options.app || !options.template || !options.out))
    throw new Error("--app, --template and --out are required");
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error("--runs must be a positive integer");
  return options;
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function executableOf(appBundle) {
  const bundle = resolve(appBundle);
  const plist = await readFile(join(bundle, "Contents", "Info.plist"), "utf8");
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!name) throw new Error(`${bundle} has no CFBundleExecutable`);
  return join(bundle, "Contents", "MacOS", name);
}

function launchEnvironment(home, dataRoot) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_|NODE_OPTIONS$)/.test(name)
    )
  );
  return { ...inherited, HOME: home, COWORK_DESKTOP_DATA: dataRoot, PI_TELEMETRY: "0" };
}

/** Parse the process table once so every mark uses the same snapshot. */
async function processTable() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,args="], {
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) return undefined;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]),
        time: match[4],
        command: match[5]
      };
    })
    .filter(Boolean);
}

function cpuSeconds(value) {
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function descendants(table, rootPid) {
  const children = new Map();
  for (const entry of table) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** The backend is the process running the backend entry; everything else is the client. */
function splitByRole(table, rootPid) {
  const tree = descendants(table, rootPid);
  const backend = tree.filter((entry) => /dist\/src\/cli\/(?:dashboard|backend)\.js/.test(entry.command));
  const backendPids = new Set(backend.map((entry) => entry.pid));
  const client = tree.filter((entry) => !backendPids.has(entry.pid));
  const sum = (entries) => entries.reduce((total, entry) => total + entry.rssKb, 0);
  return {
    client: { processes: client.length, rssKb: sum(client) },
    backend: { processes: backend.length, rssKb: sum(backend) },
    pids: { client: client.map((entry) => entry.pid), backend: backend.map((entry) => entry.pid) }
  };
}

function cpuPercent(first, second, pids, windowMs) {
  const time = (table) => new Map(table.map((entry) => [entry.pid, cpuSeconds(entry.time)]));
  const before = time(first);
  const after = time(second);
  const seconds = pids.reduce((total, pid) => {
    const delta = (after.get(pid) ?? Number.NaN) - (before.get(pid) ?? Number.NaN);
    return total + (Number.isFinite(delta) ? delta : 0);
  }, 0);
  return Number(((seconds / (windowMs / 1000)) * 100).toFixed(2));
}

async function sample(table, rootPid, options) {
  const first = table;
  const firstSplit = splitByRole(first, rootPid);
  await delay(options.cpuWindow);
  const second = await processTable();
  const secondSplit = splitByRole(second, rootPid);
  return {
    clientProcesses: secondSplit.client.processes,
    clientRssKb: secondSplit.client.rssKb,
    backendProcesses: secondSplit.backend.processes,
    backendRssKb: secondSplit.backend.rssKb,
    clientCpuPercent: cpuPercent(first, second, firstSplit.pids.client, options.cpuWindow),
    backendCpuPercent: cpuPercent(first, second, secondSplit.pids.backend, options.cpuWindow),
    pids: secondSplit.pids
  };
}

async function backendListening(logsDir) {
  try {
    for (const name of await readdir(logsDir)) {
      if (!name.endsWith(".log")) continue;
      const text = await readFile(join(logsDir, name), "utf8");
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
      if (match) return match[1];
    }
  } catch {
    /* the log directory appears with the first launch */
  }
  return undefined;
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(20);
  }
}

async function packageBytes(appBundle) {
  const { stdout } = await exec("/usr/bin/du", ["-sk", resolve(appBundle)]);
  return Number(stdout.split(/\s+/)[0]) * 1024;
}

async function oneRun(options, executable, runIndex) {
  const runRoot = await mkdtemp(join(tmpdir(), `desktop-measure-${options.label}-`));
  const home = join(runRoot, "home");
  const dataRoot = join(runRoot, "data");
  await mkdir(home, { recursive: true });
  await cp(resolve(options.template), dataRoot, { recursive: true, verbatimSymlinks: true });
  const logsDir = join(dataRoot, "logs");
  const started = performance.now();
  const errors = [];
  let log = "";
  const application = await electron.launch({
    executablePath: executable,
    args: ["--use-mock-keychain"],
    env: launchEnvironment(home, dataRoot),
    timeout: options.timeout
  });
  const rootPid = application.process().pid;
  application.process().stderr?.on("data", (chunk) => {
    log += String(chunk);
  });
  application.process().stdout?.on("data", (chunk) => {
    log += String(chunk);
  });
  const marks = {};
  let page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(String(error)));
  const ready = async () => {
    await page.locator(".app-topbar").waitFor({ state: "visible", timeout: options.timeout });
    await page.waitForFunction(() => document.readyState === "complete", undefined, {
      timeout: options.timeout
    });
  };
  try {
    const listening = await waitFor(() => backendListening(logsDir), options.timeout, "backend listening");
    marks.backendReadyMs = Math.round(performance.now() - started);
    await ready();
    marks.windowReadyMs = Math.round(performance.now() - started);
    // Start-up ramp: the highest client footprint before the app settles.
    let peakKb = 0;
    while (performance.now() - started < options.settle) {
      const table = await processTable();
      peakKb = Math.max(peakKb, splitByRole(table, rootPid).client.rssKb);
      await delay(200);
    }
    marks.startupPeakClientRssKb = peakKb;
    const settled = await sample(await processTable(), rootPid, options);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await delay(options.background);
    const background = await sample(await processTable(), rootPid, options);
    // Repeat window: close it (the app stays alive on macOS) and ask it to open one.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await delay(1_500);
    const reopenedAt = performance.now();
    const windowPromise = application.waitForEvent("window", { timeout: options.timeout });
    await application.evaluate(({ app }) => app.emit("activate"));
    page = await windowPromise;
    page.on("pageerror", (error) => errors.push(String(error)));
    await ready();
    marks.reopenedWindowReadyMs = Math.round(performance.now() - reopenedAt);
    await delay(Math.max(0, options.reopen - options.cpuWindow));
    const reopened = await sample(await processTable(), rootPid, options);
    return {
      run: runIndex + 1,
      backend: listening,
      marks,
      settled: pick(settled),
      background: pick(background),
      reopened: { windowReadyMs: marks.reopenedWindowReadyMs, ...pick(reopened) },
      errors,
      stderrBytes: log.length,
      stderrTail: log.slice(-2_000)
    };
  } finally {
    if (alive(rootPid)) {
      const closed = await Promise.race([
        application.close().then(() => "closed"),
        delay(15_000).then(() => "timeout")
      ]);
      if (closed === "timeout") process.kill(rootPid, "SIGKILL");
    }
  }
}

function pick(sampleResult) {
  return {
    clientProcesses: sampleResult.clientProcesses,
    clientRssKb: sampleResult.clientRssKb,
    backendProcesses: sampleResult.backendProcesses,
    backendRssKb: sampleResult.backendRssKb,
    clientCpuPercent: sampleResult.clientCpuPercent,
    backendCpuPercent: sampleResult.backendCpuPercent
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function series(values, { scale = 1 } = {}) {
  const scaled = values.map((value) => Math.round(value / scale));
  return { samples: scaled, median: median(scaled), peak: Math.max(...scaled) };
}

function percentSeries(values) {
  const rounded = values.map((value) => Number(value.toFixed(2)));
  return { samples: rounded, median: Number(median(rounded.map((value) => value * 100)) / 100) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const executable = await executableOf(options.app);
  await mkdir(resolve(options.out), { recursive: true });
  const runs = [];
  for (let index = 0; index < options.runs; index += 1) {
    const result = await oneRun(options, executable, index);
    runs.push(result);
    await writeFile(
      join(resolve(options.out), `${options.label}-run${index + 1}.json`),
      `${JSON.stringify(result, null, 2)}\n`
    );
    process.stdout.write(
      `run ${index + 1}: window ${result.marks.windowReadyMs}ms · backend ${result.marks.backendReadyMs}ms · ` +
        `peak ${Math.round(result.marks.startupPeakClientRssKb / 1024)}MB · ` +
        `settled ${Math.round(result.settled.clientRssKb / 1024)}+${Math.round(
          result.settled.backendRssKb / 1024
        )}MB · background ${Math.round(result.background.clientRssKb / 1024)}MB · ` +
        `reopen ${result.reopened.windowReadyMs}ms ${Math.round(result.reopened.clientRssKb / 1024)}MB\n`
    );
  }
  const summary = {
    condition: options.label,
    runs: runs.length,
    options,
    appBytes: await packageBytes(options.app),
    coldWindowReadyMs: series(runs.map((run) => run.marks.windowReadyMs)),
    coldBackendReadyMs: series(runs.map((run) => run.marks.backendReadyMs)),
    startupPeakClientRssMb: series(
      runs.map((run) => run.marks.startupPeakClientRssKb),
      { scale: 1024 }
    ),
    settledClientRssMb: series(
      runs.map((run) => run.settled.clientRssKb),
      { scale: 1024 }
    ),
    settledBackendRssMb: series(
      runs.map((run) => run.settled.backendRssKb),
      { scale: 1024 }
    ),
    settledClientCpuPercent: percentSeries(runs.map((run) => run.settled.clientCpuPercent)),
    settledBackendCpuPercent: percentSeries(runs.map((run) => run.settled.backendCpuPercent)),
    backgroundClientRssMb: series(
      runs.map((run) => run.background.clientRssKb),
      { scale: 1024 }
    ),
    backgroundClientCpuPercent: percentSeries(runs.map((run) => run.background.clientCpuPercent)),
    reopenedWindowReadyMs: series(runs.map((run) => run.reopened.windowReadyMs)),
    reopenedClientRssMb: series(
      runs.map((run) => run.reopened.clientRssKb),
      { scale: 1024 }
    ),
    clientProcesses: series(runs.map((run) => run.settled.clientProcesses)),
    backendProcesses: series(runs.map((run) => run.settled.backendProcesses)),
    rendererErrors: runs.reduce((total, run) => total + run.errors.length, 0)
  };
  await writeFile(
    join(resolve(options.out), `${options.label}-summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
