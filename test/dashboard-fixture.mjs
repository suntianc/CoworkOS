import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const harnessRoot = resolve(new URL("..", import.meta.url).pathname);

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

function scienceEnvironment(science) {
  if (science === undefined) return {};
  if (
    !science ||
    typeof science !== "object" ||
    Array.isArray(science) ||
    Object.keys(science).some(
      (key) => !["enabled", "pythonExecutable", "chemistryPythonExecutable"].includes(key)
    ) ||
    typeof science.enabled !== "boolean" ||
    (science.pythonExecutable !== undefined &&
      (typeof science.pythonExecutable !== "string" ||
        !science.pythonExecutable.trim() ||
        /[\0\r\n]/u.test(science.pythonExecutable))) ||
    (science.chemistryPythonExecutable !== undefined &&
      (typeof science.chemistryPythonExecutable !== "string" ||
        !science.chemistryPythonExecutable.trim() ||
        /[\0\r\n]/u.test(science.chemistryPythonExecutable)))
  )
    throw new Error("Dashboard science fixture accepts only enabled and an optional Python executable");
  return {
    COWORK_SCIENCE_TOOLS: science.enabled ? "1" : "0",
    ...(science.pythonExecutable ? { COWORK_SCIENCE_PYTHON: science.pythonExecutable } : {}),
    ...(science.chemistryPythonExecutable
      ? { COWORK_SCIENCE_CHEMISTRY_PYTHON: science.chemistryPythonExecutable }
      : {})
  };
}

/** A fresh real Dashboard; model connections, when supplied, are local test fixtures. */
export async function startDashboard({
  modelEndpoint,
  webSearchEndpoint,
  model = "browser-fixture",
  supportsImages = false,
  monitoring = false,
  workspace: existingWorkspace,
  supervisorIntervalMs = 1000,
  config = {},
  env = {},
  blenderExecutable,
  defaultProject = true,
  science
} = {}) {
  const scienceEnv = scienceEnvironment(science);
  const root = await mkdtemp(join(tmpdir(), "atria-dashboard-test-"));
  const workspaceRoot = existingWorkspace ?? join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  let port = await freePort();
  const isolatedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_)/.test(name))
  );
  const launchOptions = {
    cwd: harnessRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...isolatedEnv,
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_UI_PORT: String(port),
      // A connection configured through the Web UI needs the same isolation
      // as one supplied at launch. Only explicit monitoring fixtures start watchers.
      COWORK_DISABLE_WATCH_SUPERVISOR: monitoring ? "0" : "1",
      COWORK_SUPERVISOR_INTERVAL_MS: String(supervisorIntervalMs),
      ...(blenderExecutable ? { COWORK_BLENDER_EXECUTABLE: blenderExecutable } : {}),
      ...(webSearchEndpoint ? { COWORK_EXA_MCP_ENDPOINT: webSearchEndpoint } : {}),
      ...scienceEnv,
      COWORK_API_BASE: modelEndpoint ?? "",
      COWORK_API_KEY: modelEndpoint ? "local-fixture" : "",
      COWORK_SUPPORTS_IMAGES: modelEndpoint ? (supportsImages ? "1" : "0") : undefined,
      ...(modelEndpoint
        ? {
            COWORK_MODEL: model,
            COWORK_REASONING_EFFORT: "off",
            COWORK_SUPPORTS_REASONING_EFFORT: "0"
          }
        : {}),
      ...env
    }
  };
  let output = "";
  const record = (chunk) => {
    output = `${output}${chunk}`.slice(-4_000);
  };
  const launch = () => {
    const dashboardProcess = spawn(process.execPath, ["dist/src/cli/dashboard.js"], launchOptions);
    dashboardProcess.stdout.on("data", record);
    dashboardProcess.stderr.on("data", record);
    return dashboardProcess;
  };
  let child = launch();
  let base = `http://127.0.0.1:${port}`;
  const stopChild = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = new AbortController();
      try {
        await Promise.race([exited, delay(4_500, undefined, { signal: timeout.signal })]);
      } finally {
        timeout.abort();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  };
  const ready = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Dashboard exited before listening: ${output}`);
      try {
        if ((await fetch(`${base}/api/tasks`, { signal: AbortSignal.timeout(500) })).ok) {
          return;
        }
      } catch {
        /* the listener is still starting */
      }
      await delay(50);
    }
    throw new Error(`Dashboard did not become ready: ${output}`);
  };
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      await stopChild();
      await rm(root, { recursive: true, force: true });
    })());
  try {
    await ready();
    let project;
    if (defaultProject) {
      const response = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectName: "测试项目", projectDirectory: workspaceRoot })
      });
      if (!response.ok) throw new Error(`Default project creation failed: ${response.status}`);
      ({ project } = await response.json());
    }
    return {
      get base() {
        return base;
      },
      get child() {
        return child;
      },
      root,
      workspaceRoot,
      project,
      projectId: project?.projectId,
      stop,
      async restart({ newPort = false, science: nextScience } = {}) {
        const nextScienceEnv = nextScience === undefined ? undefined : scienceEnvironment(nextScience);
        await stopChild();
        if (newPort) {
          port = await freePort();
          base = `http://127.0.0.1:${port}`;
          launchOptions.env.COWORK_UI_PORT = String(port);
        }
        if (nextScienceEnv) {
          delete launchOptions.env.COWORK_SCIENCE_TOOLS;
          delete launchOptions.env.COWORK_SCIENCE_PYTHON;
          Object.assign(launchOptions.env, nextScienceEnv);
        }
        output = "";
        child = launch();
        await ready();
      }
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
