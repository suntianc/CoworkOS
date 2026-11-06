import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Measure one packaged desktop build the same way every time.
 *
 * The comparison the release work needs is between builds, so the harness owns
 * the whole condition: a fresh copy of the same data root, an isolated home, the
 * same launch arguments, and the same marks. A window counts as ready when its
 * page reports a complete document over the standard debugging endpoint, not
 * when the process merely exists. Client and backend processes are reported
 * separately because the backend is the part the architecture changes.
 *
 * Nothing here reads user data or model credentials: the data root is a template
 * the caller supplies and every run starts from a copy of it.
 */

const exec = promisify(execFile);
const HELP = `Package measurement for desktop release comparisons
  node scripts/desktop-measure.mjs --app <CoworkOS.app> --template <data root> --out <dir> [options]
  --label NAME      Condition name used in file names (default: build)
  --runs N          Launches to sample (default 3)
  --timeout MS      Extra time a launch may take in total (default 120000)
  --settle MS       Idle time before process sampling (default 30000)
  --cpu-window MS   Window between the two CPU samples (default 5000)
The template data root is copied for each run; it is never written by the harness.`;

function parseOptions(args) {
  const options = { runs: 3, timeout: 120_000, settle: 30_000, cpuWindow: 5_000, label: "build" };
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

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await new Promise((done) => probe.once("listening", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

/** Run the app with only the environment the measurement controls. */
function launchEnvironment(home, dataRoot) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_|NODE_OPTIONS$)/.test(name)
    )
  );
  return {
    ...inherited,
    HOME: home,
    COWORK_DESKTOP_DATA: dataRoot,
    PI_TELEMETRY: "0"
  };
}

async function executableOf(appBundle) {
  const bundle = resolve(appBundle);
  const plist = await readFile(join(bundle, "Contents", "Info.plist"), "utf8");
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!name) throw new Error(`${bundle} has no CFBundleExecutable`);
  return join(bundle, "Contents", "MacOS", name);
}

/** One page target is enough: the app has a single trusted window. */
async function pageTarget(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(500)
    });
    if (!response.ok) return undefined;
    const targets = await response.json();
    return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  } catch {
    return undefined;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_done, fail) => setTimeout(() => fail(new Error(`${label} timed out`)), ms).unref())
  ]);
}

async function documentComplete(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await withTimeout(
      new Promise((done, fail) => {
        socket.addEventListener("open", done, { once: true });
        socket.addEventListener("error", fail, { once: true });
      }),
      3_000,
      "devtools connection"
    );
    const answer = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("devtools did not answer")), 2_000);
      socket.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          done(JSON.parse(String(event.data)));
        },
        { once: true }
      );
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "document.readyState", returnByValue: true }
        })
      );
    });
    return answer?.result?.result?.value === "complete";
  } finally {
    socket.close();
  }
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

/** The backend is the child this client started; everything else in the tree is client. */
function splitByRole(table, rootPid) {
  const tree = descendants(table, rootPid);
  const backend = tree.filter((entry) => /dist\/src\/cli\/(?:dashboard|backend)\.js/.test(entry.command));
  const backendPids = new Set(backend.map((entry) => entry.pid));
  const client = tree.filter((entry) => !backendPids.has(entry.pid));
  const total = (entries, field) => entries.reduce((sum, entry) => sum + entry[field], 0);
  return {
    client: { processes: client.length, rssKb: total(client, "rssKb") },
    backend: { processes: backend.length, rssKb: total(backend, "rssKb") },
    pids: { client: client.map((entry) => entry.pid), backend: backend.map((entry) => entry.pid) }
  };
}

function cpuByRole(first, second, clientPids, backendPids, windowMs) {
  const time = (table) => new Map(table.map((entry) => [entry.pid, cpuSeconds(entry.time)]));
  const before = time(first);
  const after = time(second);
  const percent = (pids) =>
    (pids.reduce((sum, pid) => {
      const delta = (after.get(pid) ?? Number.NaN) - (before.get(pid) ?? Number.NaN);
      return sum + (Number.isFinite(delta) ? delta : 0);
    }, 0) /
      (windowMs / 1000)) *
    100;
  return { client: percent(clientPids), backend: percent(backendPids) };
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

async function backendListening(logsDir) {
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(logsDir)) {
      if (!name.endsWith(".log")) continue;
      const text = await readFile(join(logsDir, name), "utf8");
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
      if (match) return { url: match[1], log: name };
    }
  } catch {
    /* the log directory appears with the first launch */
  }
  return undefined;
}

/**
 * Stop the launch under measurement without measuring its shutdown.
 *
 * The quit path is not part of this comparison, so it gets a short grace and
 * then a hard stop; the backend is stopped by pid because the baseline build
 * detaches it and a killed parent would otherwise leave it running.
 */
async function stopProcess(pid, descendantsPids) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await delay(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  for (const child of descendantsPids) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function oneRun(options, executable, runIndex) {
  const runRoot = await mkdtemp(join(tmpdir(), `desktop-measure-${options.label}-`));
  const home = join(runRoot, "home");
  const dataRoot = join(runRoot, "data");
  await mkdir(home, { recursive: true });
  await cp(resolve(options.template), dataRoot, { recursive: true, verbatimSymlinks: true });
  const logsDir = join(dataRoot, "logs");
  const debugPort = await freePort();
  const started = performance.now();
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    env: launchEnvironment(home, dataRoot),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const marks = {};
  let table;
  let cpuDone;
  try {
    const listening = await waitFor(() => backendListening(logsDir), options.timeout, "backend listening");
    marks.backendReadyMs = Math.round(performance.now() - started);
    await waitFor(
      async () => {
        const target = await pageTarget(debugPort);
        if (!target) return undefined;
        try {
          return (await documentComplete(target)) ? target : undefined;
        } catch {
          return undefined;
        }
      },
      options.timeout,
      "window document complete"
    );
    marks.windowReadyMs = Math.round(performance.now() - started);
    await delay(options.settle);
    table = await processTable();
    const first = table;
    const firstSplit = splitByRole(first, child.pid);
    await delay(options.cpuWindow);
    const second = await processTable();
    const secondSplit = splitByRole(second, child.pid);
    cpuDone = cpuByRole(first, second, firstSplit.pids.client, secondSplit.pids.backend, options.cpuWindow);
    const exit = await Promise.race([exited, delay(0).then(() => undefined)]);
    if (exit) throw new Error(`the app exited during measurement: ${JSON.stringify(exit)}`);
    await stopProcess(child.pid, [...secondSplit.pids.client, ...secondSplit.pids.backend]);
    await exited;
    return {
      run: runIndex + 1,
      labels: { app: basename(executable), ...options },
      marks,
      process: {
        clientProcesses: secondSplit.client.processes,
        clientRssKb: secondSplit.client.rssKb,
        backendProcesses: secondSplit.backend.processes,
        backendRssKb: secondSplit.backend.rssKb,
        clientCpuPercent: Number(cpuDone.client.toFixed(2)),
        backendCpuPercent: Number(cpuDone.backend.toFixed(2))
      },
      backend: listening
    };
  } finally {
    const live = table ? splitByRole(table, child.pid) : { pids: { client: [], backend: [] } };
    await stopProcess(child.pid, [...live.pids.client, ...live.pids.backend]);
    await writeFile(join(runRoot, "stderr.log"), stderr);
    marks.stderrBytes = stderr.length;
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
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
        `client ${Math.round(result.process.clientRssKb / 1024)}MB · backend ${Math.round(
          result.process.backendRssKb / 1024
        )}MB\n`
    );
  }
  const summary = {
    condition: options.label,
    runs: runs.length,
    windowReadyMs: {
      samples: runs.map((run) => run.marks.windowReadyMs),
      median: median(runs.map((run) => run.marks.windowReadyMs))
    },
    backendReadyMs: {
      samples: runs.map((run) => run.marks.backendReadyMs),
      median: median(runs.map((run) => run.marks.backendReadyMs))
    },
    clientRssMb: {
      samples: runs.map((run) => Math.round(run.process.clientRssKb / 1024)),
      median: median(runs.map((run) => Math.round(run.process.clientRssKb / 1024)))
    },
    backendRssMb: {
      samples: runs.map((run) => Math.round(run.process.backendRssKb / 1024)),
      median: median(runs.map((run) => Math.round(run.process.backendRssKb / 1024)))
    },
    clientCpuPercent: { samples: runs.map((run) => run.process.clientCpuPercent) },
    backendCpuPercent: { samples: runs.map((run) => run.process.backendCpuPercent) }
  };
  await writeFile(
    join(resolve(options.out), `${options.label}-summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
