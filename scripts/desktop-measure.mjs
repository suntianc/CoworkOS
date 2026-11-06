import { _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { splitByRole, cpuPercent, logOffsets, backendListening } from "./desktop-measure-support.mjs";

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
  --scratch DIR      Isolated temporary data roots (default: .tmp/desktop-measure)
  --confirm-unsaved-test-quit  Select the known unsaved-draft warning for isolated test data
The template data root is copied for each run; it is never written by the harness.`;

function parseOptions(args) {
  const options = {
    runs: 3,
    timeout: 120_000,
    settle: 30_000,
    background: 10_000,
    reopen: 15_000,
    cpuWindow: 5_000,
    label: "build",
    scratch: ".tmp/desktop-measure"
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
    else if (argument === "--scratch") options.scratch = value();
    else if (argument === "--confirm-unsaved-test-quit") options.confirmUnsavedTestQuit = true;
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

function backendRoots(table, rootPid, instance) {
  if (instance) return [instance.pid];
  // Legacy builds own their dashboard child; restrict discovery to this app tree.
  const descendants = new Set([rootPid]);
  let previous;
  do {
    previous = descendants.size;
    for (const entry of table) if (descendants.has(entry.ppid)) descendants.add(entry.pid);
  } while (descendants.size !== previous);
  return table
    .filter((entry) => descendants.has(entry.pid) && /dist\/src\/cli\/dashboard\.js/.test(entry.command))
    .map((entry) => entry.pid);
}

async function sample(rootPid, instance, options) {
  const first = await processTable();
  const firstAt = performance.now();
  const firstSplit = splitByRole(first, rootPid, backendRoots(first, rootPid, instance));
  await delay(options.cpuWindow);
  const second = await processTable();
  const elapsed = performance.now() - firstAt;
  const secondSplit = splitByRole(second, rootPid, backendRoots(second, rootPid, instance));
  const cpu = (role) => {
    const before = firstSplit.pids[role];
    const after = secondSplit.pids[role];
    if (before.length !== after.length || before.some((pid) => !after.includes(pid))) return null;
    return cpuPercent(first, second, before, elapsed);
  };
  return {
    clientProcesses: secondSplit.client.processes,
    clientRssKb: secondSplit.client.rssKb,
    backendProcesses: secondSplit.backend.processes,
    backendRssKb: secondSplit.backend.rssKb,
    clientCpuPercent: cpu("client"),
    backendCpuPercent: cpu("backend"),
    pids: secondSplit.pids
  };
}

async function readInstance(dataRoot) {
  let record;
  try {
    record = JSON.parse(await readFile(join(dataRoot, "runtime", "backend-instance.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    record.version !== 1 ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.backendId !== "string" ||
    !record.backendId ||
    typeof record.token !== "string" ||
    !record.token ||
    record.url !== `http://127.0.0.1:${record.port}` ||
    !Number.isInteger(record.port)
  )
    throw new Error("invalid isolated backend instance record");
  return record;
}

async function verifyInstance(instance) {
  const response = await fetch(`${instance.url}/api/backend`, {
    headers: { "x-atria-token": instance.token },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`backend identity HTTP ${response.status}`);
  const identity = await response.json();
  if (identity.backendId !== instance.backendId || identity.pid !== instance.pid)
    throw new Error("backend identity differs from isolated instance record");
}

async function stopOwnedBackend(dataRoot, expected, executable, options, home) {
  if (!expected) return { kind: "legacy-app-owned" };
  const current = await readInstance(dataRoot);
  if (
    !current ||
    current.pid !== expected.pid ||
    current.backendId !== expected.backendId ||
    current.token !== expected.token ||
    current.url !== expected.url
  )
    throw new Error("refusing to stop: backend instance identity changed");
  await verifyInstance(current);
  const appRoot = resolve(options.app, "Contents/Resources/app");
  const entry = join(appRoot, "dist/src/cli/backend.js");
  const env = { ...launchEnvironment(home, dataRoot), ATRIA_HOME: dataRoot, ELECTRON_RUN_AS_NODE: "1" };
  const { stdout, stderr } = await exec(executable, [entry, "stop"], { cwd: appRoot, env, timeout: 45_000 });
  if ((await readInstance(dataRoot)) || alive(expected.pid)) throw new Error("backend stop did not complete");
  return { kind: "standalone", backendId: expected.backendId, pid: expected.pid, stdout, stderr };
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
  await mkdir(resolve(options.scratch), { recursive: true });
  const runRoot = await mkdtemp(join(resolve(options.scratch), `desktop-measure-${options.label}-`));
  const home = join(runRoot, "home");
  const dataRoot = join(runRoot, "data");
  await mkdir(home, { recursive: true });
  await cp(resolve(options.template), dataRoot, { recursive: true, verbatimSymlinks: true });
  if (await readInstance(dataRoot)) throw new Error("template contains a backend instance record");
  const logsDir = join(dataRoot, "logs");
  const errors = [];
  let log = "";
  let application;
  let rootPid;
  let instance;
  let legacyRoots = [];
  let result;
  const launch = async (phase) => {
    const app = await electron.launch({
      executablePath: executable,
      args: ["--use-mock-keychain"],
      env: launchEnvironment(home, dataRoot),
      timeout: options.timeout
    });
    app.process().stderr?.on("data", (chunk) => {
      log += String(chunk);
    });
    app.process().stdout?.on("data", (chunk) => {
      log += String(chunk);
    });
    if (options.confirmUnsavedTestQuit) {
      await app.evaluate(({ dialog }, phaseName) => {
        const show = dialog.showMessageBox;
        dialog.showMessageBox = async (...args) => {
          const prompt = args.at(-1);
          const expectedDetail = "请返回处理草稿保存错误或文档冲突。仍然退出会丢失未保存的更改。";
          const buttons = prompt?.buttons;
          if (
            prompt?.type === "warning" &&
            prompt.message === "有文档或任务草稿尚未保存" &&
            prompt.detail === expectedDetail &&
            prompt.defaultId === 0 &&
            prompt.cancelId === 0 &&
            Array.isArray(buttons) &&
            buttons.length === 2 &&
            buttons[0] === "返回编辑器" &&
            buttons[1] === "仍然退出"
          ) {
            console.log(`MEASURE_CONFIRMED_TEST_QUIT ${JSON.stringify({ phase: phaseName, response: 1 })}`);
            return { response: 1, checkboxChecked: false };
          }
          return show(...args);
        };
      }, phase);
    }
    return app;
  };
  const ready = async (page) => {
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.locator(".app-topbar").waitFor({ state: "visible", timeout: options.timeout });
    await page.waitForFunction(() => document.readyState === "complete", undefined, {
      timeout: options.timeout
    });
  };
  const close = async (app) => {
    const pid = app.process().pid;
    const closed = await Promise.race([app.close().then(() => true), delay(15_000).then(() => false)]);
    if (!closed || alive(pid)) throw new Error(`normal app exit did not complete for pid ${pid}`);
  };
  const cleanupOwned = async () => {
    if (application && rootPid && alive(rootPid)) {
      try {
        await close(application);
      } catch (error) {
        // This is failure cleanup of the exact app process we launched, never a successful hot start.
        process.kill(rootPid, "SIGKILL");
        await waitFor(() => !alive(rootPid), 5000, "owned app exit");
        log += `\ncleanup: ${error.message}\n`;
      }
    }
    if (!instance) {
      // The old app owns a dashboard child. Only a previously observed child whose
      // PID and full command still match can receive its graceful termination signal.
      const table = await processTable();
      for (const owned of legacyRoots) {
        const current = table.find((entry) => entry.pid === owned.pid);
        if (current && current.command === owned.command) {
          process.kill(owned.pid, "SIGTERM");
          await waitFor(() => !alive(owned.pid), 30_000, "owned legacy backend exit");
        } else if (current) throw new Error("legacy backend PID was reused; refusing cleanup");
      }
    }
    try {
      const cleanup = await stopOwnedBackend(
        dataRoot,
        instance ?? (await readInstance(dataRoot)),
        executable,
        options,
        home
      );
      await writeFile(
        join(resolve(options.out), `${options.label}-run${runIndex + 1}-cleanup.json`),
        `${JSON.stringify(cleanup, null, 2)}\n`
      );
    } finally {
      await writeFile(join(resolve(options.out), `${options.label}-run${runIndex + 1}-process.log`), log);
    }
  };
  try {
    const offsets = await logOffsets(logsDir);
    const started = performance.now();
    application = await launch("cold");
    rootPid = application.process().pid;
    let page = await application.firstWindow();
    const listening = await waitFor(
      () => backendListening(logsDir, offsets),
      options.timeout,
      "backend listening"
    );
    const marks = { backendReadyMs: Math.round(performance.now() - started) };
    await ready(page);
    marks.windowReadyMs = Math.round(performance.now() - started);
    instance = await readInstance(dataRoot);
    if (instance) await verifyInstance(instance);
    const firstTable = await processTable();
    legacyRoots = instance
      ? []
      : backendRoots(firstTable, rootPid, undefined).map((pid) => {
          const entry = firstTable.find((row) => row.pid === pid);
          return { pid, command: entry.command };
        });
    if (!instance && !legacyRoots.length) throw new Error("legacy backend process was not found in app tree");
    let peakKb = 0;
    while (performance.now() - started < options.settle) {
      const table = await processTable();
      peakKb = Math.max(
        peakKb,
        splitByRole(table, rootPid, backendRoots(table, rootPid, instance)).client.rssKb
      );
      await delay(200);
    }
    if (!peakKb) {
      const table = await processTable();
      peakKb = splitByRole(table, rootPid, backendRoots(table, rootPid, instance)).client.rssKb;
    }
    marks.startupPeakClientRssKb = peakKb;
    const settled = await sample(rootPid, instance, options);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await delay(options.background);
    const background = await sample(rootPid, instance, options);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await delay(1_500);
    const reopenedAt = performance.now();
    const windowPromise = application.waitForEvent("window", { timeout: options.timeout });
    await application.evaluate(({ app }) => app.emit("activate"));
    page = await windowPromise;
    await ready(page);
    marks.reopenedWindowReadyMs = Math.round(performance.now() - reopenedAt);
    await delay(Math.max(0, options.reopen - options.cpuWindow));
    const reopened = await sample(rootPid, instance, options);
    await close(application);
    application = undefined;
    if (instance) await verifyInstance(instance);
    else if (legacyRoots.some(({ pid }) => alive(pid)))
      throw new Error("legacy backend survived normal app exit");
    const hotStarted = performance.now();
    application = await launch("hot");
    rootPid = application.process().pid;
    page = await application.firstWindow();
    await ready(page);
    const hotWindowReadyMs = Math.round(performance.now() - hotStarted);
    const hotInstance = await readInstance(dataRoot);
    if (instance) {
      if (
        !hotInstance ||
        hotInstance.pid !== instance.pid ||
        hotInstance.backendId !== instance.backendId ||
        hotInstance.token !== instance.token
      )
        throw new Error("backend identity changed across hot restart");
      await verifyInstance(hotInstance);
    } else {
      const table = await processTable();
      legacyRoots = backendRoots(table, rootPid, undefined).map((pid) => ({
        pid,
        command: table.find((row) => row.pid === pid).command
      }));
      if (!legacyRoots.length) throw new Error("legacy hot backend process was not found");
    }
    const hot = await sample(rootPid, hotInstance, options);
    await close(application);
    application = undefined;
    if (!instance && legacyRoots.some(({ pid }) => alive(pid)))
      throw new Error("legacy hot backend survived normal app exit");
    result = {
      run: runIndex + 1,
      runRoot,
      backend: listening,
      marks,
      settled: pick(settled),
      background: pick(background),
      reopened: { windowReadyMs: marks.reopenedWindowReadyMs, ...pick(reopened) },
      hot: { windowReadyMs: hotWindowReadyMs, ...pick(hot) },
      quitConfirmations: [...log.matchAll(/MEASURE_CONFIRMED_TEST_QUIT (\{[^\n]*\})/g)].map((match) =>
        JSON.parse(match[1])
      ),
      errors
    };
  } finally {
    await cleanupOwned();
  }
  return result;
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
  if (values.some((value) => value === null)) return { samples: values, median: null };
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
    hotWindowReadyMs: series(runs.map((run) => run.hot.windowReadyMs)),
    hotClientRssMb: series(
      runs.map((run) => run.hot.clientRssKb),
      { scale: 1024 }
    ),
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
