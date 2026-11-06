import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

/**
 * The standalone backend, driven the way a client drives it.
 *
 * Every case starts a real detached process from the backend entry, talks to
 * it over the local HTTP API, and only then asks the process to stop. The
 * point is the seam between a client's lifetime and the backend's: a task has
 * to keep running after the client that started it exits, the instance has to
 * be the same one when the client reconnects, and an explicit stop has to
 * finish managed work instead of abandoning it.
 */

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");
const backendModuleUrl = pathToFileURL(backendEntry).href;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

function isolatedEnv(overrides) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
  );
  return { ...inherited, ...overrides };
}

async function createRoot(prefix, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  const project = join(base, "project");
  const userHome = join(base, "user-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(userHome, { recursive: true });
  const configPath = join(base, "config.json");
  await writeFile(configPath, "{}");
  const env = isolatedEnv({
    HOME: userHome,
    ATRIA_HOME: home,
    PI_CODING_AGENT_DIR: join(base, "pi"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    COWORK_HARNESS_ROOT: repositoryRoot,
    COWORK_WORKSPACE: workspace,
    COWORK_GLOBAL_INDEX: join(home, "runtime", "workspaces.json"),
    COWORK_TABS_INDEX: join(home, "runtime", "tabs.json"),
    COWORK_CONFIG: configPath,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    COWORK_SUPERVISOR_INTERVAL_MS: "1000",
    ...extra
  });
  return { base, home, workspace, project, userHome, configPath, env };
}

function runProcess(entry, args, env, timeoutMs = 60_000) {
  const child = spawn(entry, args, {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  const closed = new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${entry} ${args.join(" ")} timed out\n${out}\n${err}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  return closed.then((code) => ({ code, out: out.trim(), err: err.trim() }));
}

async function runBackend(args, env) {
  const result = await runProcess(process.execPath, [backendEntry, ...args], env);
  return result;
}

async function backendCommand(args, env, expectedState) {
  const result = await runBackend(args, env);
  assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.err || result.out}`);
  const parsed = JSON.parse(result.out);
  if (expectedState) assert.equal(parsed.state, expectedState, result.out);
  return parsed;
}

const startBackend = (env) => backendCommand(["start"], env);
const stopBackend = (env) => backendCommand(["stop"], env);
const instancePath = (root) => join(root.home, "runtime", "backend-instance.json");

async function readInstance(root) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(instancePath(root), "utf8"));
      if (value.pid && value.url && value.token) return value;
    } catch {
      /* the record is published after the listener is ready */
    }
    await delay(25);
  }
  throw new Error("backend did not publish an instance record");
}

async function api(root, method, path, body) {
  const instance = await readInstance(root);
  const headers = { "x-atria-token": instance.token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${instance.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function waitFor(description, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(50);
  }
}

async function createTask(root) {
  const project = await api(root, "POST", "/api/projects", {
    projectName: "守护进程项目",
    projectDirectory: root.project
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const task = await api(root, "POST", "/api/tasks", {
    taskId: "daemon-task",
    goal: "整理输入并交付报告",
    projectId: project.body.project.projectId
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  return project.body.project;
}

async function stopQuietly(root) {
  try {
    await runBackend(["stop"], root.env);
  } catch {
    /* fall through to the recorded pid */
  }
  try {
    const instance = JSON.parse(await readFile(instancePath(root), "utf8"));
    if (instance.pid && alive(instance.pid)) process.kill(instance.pid, "SIGKILL");
  } catch {
    /* no record or the process is gone */
  }
}

async function serviceArtifacts(root) {
  const found = [];
  for (const candidate of [
    join(root.userHome, "Library", "LaunchAgents"),
    join(root.userHome, ".config", "systemd", "user"),
    join(root.home, "Library", "LaunchAgents")
  ]) {
    try {
      const entries = await readdir(candidate);
      if (entries.length) found.push(`${candidate}: ${entries.join(", ")}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return found;
}

test(
  "a detached backend finishes a task after its client exits and stays the same instance on reconnect",
  { timeout: 150_000 },
  async (t) => {
    const root = await createRoot("atria-daemon-continue-");
    let model;
    t.after(async () => {
      await stopQuietly(root);
      await model?.close();
      await rm(root.base, { recursive: true, force: true });
    });
    const report = "# 守护进程报告\n\n输入已核对。\n";
    const failures = [];
    let step = 0;
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    let gated = false;
    model = await modelProtocolFixture("openai-completions", async (request) => {
      try {
        const last = request.messages.findLast((message) => message.role === "tool");
        if (!gated) {
          gated = true;
          // Hold the first model answer until the client that started the run is gone.
          await gate;
        }
        switch (step++) {
          case 0:
            return { name: "read", arguments: { path: join(root.project, "input.txt") } };
          case 1:
            assert.match(JSON.stringify(last.content), /守护进程输入/);
            return { name: "write", arguments: { path: join(root.project, "report.md"), content: report } };
          case 2:
            return { name: "enable_tools", arguments: { groups: ["delivery"] } };
          case 3:
            return { name: "publish_artifact", arguments: { sourcePath: join(root.project, "report.md") } };
          default:
            assert.match(JSON.stringify(last.content), /report\.md/);
            return { text: "报告已生成并交付。" };
        }
      } catch (error) {
        failures.push(error.message);
        return { text: "回归失败。" };
      }
    });
    root.env = {
      ...root.env,
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0"
    };
    await writeFile(join(root.project, "input.txt"), "守护进程输入");
    const started = await startBackend(root.env);
    assert.equal(started.state, "started");
    const instance = await readInstance(root);
    assert.equal(instance.backendId, started.backendId);
    assert.equal(instance.pid, started.pid);

    // This client creates the Task, starts the Run and exits. Nothing it owns
    // keeps the backend or the Run alive afterwards.
    const clientPath = join(root.base, "client.mjs");
    await writeFile(
      clientPath,
      `
const [url, token, projectDirectory] = process.argv.slice(2);
const headers = { "content-type": "application/json", "x-atria-token": token };
const call = async (path, body) => {
  const response = await fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(path + " " + response.status + " " + JSON.stringify(value));
  return value;
};
const project = await call("/api/projects", { projectName: "守护进程项目", projectDirectory });
await call("/api/tasks", { taskId: "daemon-task", goal: "整理输入并交付报告", projectId: project.project.projectId });
await call("/api/tasks/daemon-task/run", { prompt: "读取 input.txt，生成 report.md 并发布为产物。" });
process.stdout.write("started");
`
    );
    const client = await runProcess(
      process.execPath,
      [clientPath, instance.url, instance.token, root.project],
      root.env
    );
    assert.equal(client.code, 0, client.err);
    assert.equal(client.out, "started");

    const during = await api(root, "GET", "/api/tasks/daemon-task");
    assert.equal(during.status, 200);
    assert.equal(during.body.runtime.active, true, "the Run must outlive the client");
    assert.deepEqual(during.body.artifacts, [], "the Run has not produced its artifact yet");
    release();
    const detail = await waitFor("the task to complete without a client", async () => {
      const current = await api(root, "GET", "/api/tasks/daemon-task");
      return !current.body.runtime.active && current.body.task.status === "completed"
        ? current.body
        : undefined;
    });
    assert.deepEqual(failures, []);
    assert.equal(await readFile(join(root.project, "report.md"), "utf8"), report);
    assert.ok(
      detail.artifacts.some((item) => item.relativePath === "report.md"),
      JSON.stringify(detail.artifacts)
    );

    // Reconnecting reaches the same Task, the same artifact and the same backend.
    const identity = await api(root, "GET", "/api/backend");
    assert.equal(identity.status, 200);
    assert.equal(identity.body.backendId, instance.backendId);
    assert.equal(identity.body.pid, instance.pid);
    const reconnected = await api(root, "GET", "/api/tasks/daemon-task");
    assert.equal(reconnected.body.task.taskId, "daemon-task");
    assert.equal(reconnected.body.task.goal, "整理输入并交付报告");
    const download = await fetch(`${instance.url}/api/tasks/daemon-task/artifact?path=report.md&download=1`, {
      headers: { "x-atria-token": instance.token }
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), report);

    // A second start reports the serving instance instead of replacing it.
    const second = await startBackend(root.env);
    assert.equal(second.state, "running");
    assert.equal(second.backendId, started.backendId);
    assert.equal(second.pid, started.pid);

    const stopped = await stopBackend(root.env);
    assert.equal(stopped.state, "stopped");
    assert.equal(alive(started.pid), false);
    await assert.rejects(readFile(instancePath(root), "utf8"), /ENOENT/);

    // Restarting keeps the Backend identity and the Task history on disk.
    const restarted = await startBackend(root.env);
    assert.equal(restarted.state, "started");
    assert.equal(restarted.backendId, started.backendId);
    assert.notEqual(restarted.pid, started.pid);
    const afterRestart = await api(root, "GET", "/api/tasks/daemon-task");
    assert.equal(afterRestart.body.task.taskId, "daemon-task");
    assert.ok(afterRestart.body.artifacts.some((item) => item.relativePath === "report.md"));
    const downloadAgain = await fetch(
      `${(await readInstance(root)).url}/api/tasks/daemon-task/artifact?path=report.md&download=1`,
      { headers: { "x-atria-token": (await readInstance(root)).token } }
    );
    assert.equal(downloadAgain.status, 200);
    assert.equal(await downloadAgain.text(), report);
  }
);

test(
  "an explicit stop reaps a live managed Run and a restart keeps backend identity and task history",
  { timeout: 120_000 },
  async (t) => {
    const root = await createRoot("atria-daemon-stop-");
    const model = await modelProtocolFixture("openai-completions", () => new Promise(() => {}));
    t.after(async () => {
      await stopQuietly(root);
      await model.close();
      await rm(root.base, { recursive: true, force: true });
    });
    root.env = {
      ...root.env,
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0"
    };
    const started = await startBackend(root.env);
    const instance = await readInstance(root);
    await createTask(root);
    const run = await api(root, "POST", "/api/tasks/daemon-task/run", {
      prompt: "读取 input.txt 并一直等待模型回答。"
    });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const active = await waitFor("the run to become active", async () => {
      const current = await api(root, "GET", "/api/tasks/daemon-task");
      return current.body.runtime.active ? current.body : undefined;
    });
    const heartbeat = JSON.parse(
      await waitFor("the Main heartbeat", async () => {
        try {
          return await readFile(
            join(active.storageRoot, "daemon-task", "agents", "main", "heartbeat.json"),
            "utf8"
          );
        } catch {
          return undefined;
        }
      })
    );
    assert.ok(alive(heartbeat.pid), "the managed Main process is running");

    // The same data root still names one instance.
    const second = await startBackend(root.env);
    assert.equal(second.state, "running");
    assert.equal(second.pid, started.pid);
    assert.equal(second.backendId, started.backendId);

    const stopped = await stopBackend(root.env);
    assert.equal(stopped.state, "stopped");
    assert.equal(alive(started.pid), false, "the backend exited");
    await waitFor("the managed Main process to be reaped", async () => !alive(heartbeat.pid), 10_000);

    const restarted = await startBackend(root.env);
    assert.equal(restarted.backendId, started.backendId);
    assert.notEqual(restarted.pid, started.pid);
    const recovered = await api(root, "GET", "/api/tasks/daemon-task");
    assert.equal(recovered.body.task.taskId, "daemon-task");
    assert.equal(recovered.body.task.goal, "整理输入并交付报告");
    assert.equal(recovered.body.runtime.active, false, "the stopped Run is not reported as live");
    assert.equal((await backendCommand(["status"], root.env)).state, "running");
  }
);

test(
  "a record naming a live process it cannot verify is a conflict, not a startup race",
  { timeout: 60_000 },
  async (t) => {
    const root = await createRoot("atria-daemon-conflict-");
    const placeholder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore"
    });
    t.after(async () => {
      try {
        process.kill(placeholder.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await rm(root.base, { recursive: true, force: true });
    });
    const directory = join(root.home, "runtime");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "backend-instance.json"),
      JSON.stringify({
        version: 1,
        backendId: "backend_foreign",
        createdAt: new Date().toISOString(),
        pid: placeholder.pid,
        port: 1,
        url: "http://127.0.0.1:1",
        token: "fixture-token",
        startedAt: new Date().toISOString()
      })
    );
    const status = await backendCommand(["status"], root.env);
    assert.equal(status.state, "conflict", JSON.stringify(status));
    assert.equal(status.pid, placeholder.pid);
    const attempted = await runBackend(["start"], root.env);
    assert.notEqual(attempted.code, 0, "start must refuse an unverifiable live process");
    assert.match(attempted.err, /无法确认|冲突|身份/, attempted.err);
    assert.equal(alive(placeholder.pid), true, "the unrelated process is never signalled");
    // The refused start left the foreign record and process untouched.
    const current = JSON.parse(await readFile(instancePath(root), "utf8"));
    assert.equal(current.backendId, "backend_foreign");
    assert.equal(current.pid, placeholder.pid);
  }
);

test(
  "starting or importing the backend installs no system service, and an application MCP server stops and restarts with it",
  { timeout: 150_000 },
  async (t) => {
    const root = await createRoot("atria-daemon-service-");
    t.after(async () => {
      await stopQuietly(root);
      await rm(root.base, { recursive: true, force: true });
    });
    root.env = { ...root.env, COWORK_APPLICATION_DUMMY: "1" };

    // Importing the entry must not serve, record an instance or touch an
    // OS-level service manager.
    const imported = await runProcess(
      process.execPath,
      ["-e", `import(${JSON.stringify(backendModuleUrl)}).then(() => console.log("imported"))`],
      root.env,
      30_000
    );
    assert.equal(imported.code, 0, imported.err);
    assert.match(imported.out, /imported/);
    await assert.rejects(readFile(instancePath(root), "utf8"), /ENOENT/);
    assert.deepEqual(await serviceArtifacts(root), []);

    const started = await startBackend(root.env);
    assert.deepEqual(await serviceArtifacts(root), [], "starting the backend must not register a service");
    await createTask(root);
    const opened = await api(root, "POST", "/api/tasks/daemon-task/app-instances/open", {
      appType: "dummy-counter"
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.mcp?.state, "running", JSON.stringify(opened.body.mcp));
    const appInstanceId = opened.body.appInstance.appInstanceId;
    const servers = await api(root, "GET", "/api/workbench/mcp/status");
    const first = servers.body.servers.find((server) => server.key.endsWith(appInstanceId));
    assert.ok(first, JSON.stringify(servers.body.servers));
    assert.ok(alive(first.pid), "the MCP server is a real child process");

    const stopped = await stopBackend(root.env);
    assert.equal(stopped.state, "stopped");
    assert.equal(alive(started.pid), false);
    await waitFor("the MCP server to stop with the backend", async () => !alive(first.pid), 10_000);
    assert.deepEqual(await serviceArtifacts(root), []);

    const restarted = await startBackend(root.env);
    assert.equal(restarted.backendId, started.backendId);
    assert.notEqual(restarted.pid, started.pid);
    const reopened = await api(root, "POST", "/api/tasks/daemon-task/app-instances/open", {
      appType: "dummy-counter"
    });
    assert.equal(reopened.status, 201, JSON.stringify(reopened.body));
    assert.equal(reopened.body.mcp?.state, "running", JSON.stringify(reopened.body.mcp));
    const afterRestart = await api(root, "GET", "/api/workbench/mcp/status");
    const second = afterRestart.body.servers.find((server) =>
      server.key.endsWith(reopened.body.appInstance.appInstanceId)
    );
    assert.ok(second, JSON.stringify(afterRestart.body.servers));
    assert.ok(alive(second.pid), "the MCP server restarted with the backend");
    assert.notEqual(second.pid, first.pid);
  }
);

test("jobs close normally and long-term goals survive an explicit stop", { timeout: 150_000 }, async (t) => {
  const root = await createRoot("atria-daemon-jobs-");
  let model;
  t.after(async () => {
    await stopQuietly(root);
    await model?.close();
    await rm(root.base, { recursive: true, force: true });
  });
  const failures = [];
  let step = 0;
  model = await modelProtocolFixture("openai-completions", (request) => {
    try {
      const last = request.messages.findLast((message) => message.role === "tool");
      const toolText = Array.isArray(last?.content)
        ? last.content.map((part) => part.text ?? "").join("")
        : String(last?.content ?? "");
      const result = toolText ? JSON.parse(toolText) : {};
      switch (step++) {
        case 0:
          return { name: "grant_capabilities", arguments: { longRunning: true, reason: "夹具长时间任务" } };
        case 1:
          return { name: "enable_tools", arguments: { groups: ["jobs"] } };
        case 2:
          return {
            name: "start_job",
            arguments: {
              command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`,
              cwd: root.project
            }
          };
        case 3:
          assert.equal(result.jobId, "job-1", toolText);
          return { name: "check_job", arguments: { jobId: "job-1" } };
        case 4:
          assert.equal(result.state, "running", toolText);
          return { name: "kill_job", arguments: { jobId: "job-1" } };
        case 5:
          assert.equal(result.state, "exited", toolText);
          return { text: "后台任务已关闭。" };
        default:
          // A job-exit wake can arrive after the explicit kill; it needs no
          // new tool work and must not turn the completed Task into a failure.
          return { text: "后台任务已关闭。" };
      }
    } catch (error) {
      failures.push(error.message);
      return { text: "回归失败。" };
    }
  });
  root.env = {
    ...root.env,
    COWORK_API_BASE: model.baseUrl,
    COWORK_API_KEY: "local-fixture",
    COWORK_MODEL: "protocol-fixture",
    COWORK_REASONING_EFFORT: "off",
    COWORK_SUPPORTS_REASONING_EFFORT: "0"
  };
  const started = await startBackend(root.env);
  await createTask(root);
  const run = await api(root, "POST", "/api/tasks/daemon-task/run", {
    prompt: "启动一个后台命令，确认它在运行，然后正常关闭它。"
  });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const completed = await waitFor("the job run to settle", async () => {
    const current = await api(root, "GET", "/api/tasks/daemon-task");
    return !current.body.runtime.active && ["completed", "failed"].includes(current.body.task.status)
      ? current.body
      : undefined;
  });
  assert.deepEqual(failures, []);
  assert.equal(completed.task.status, "completed", JSON.stringify(completed.task));
  const job = completed.jobs.find((entry) => entry.jobId === "job-1");
  assert.ok(job, JSON.stringify(completed.jobs));
  assert.equal(job.state, "exited", "the job was closed while the backend was live");

  const goal = await api(root, "POST", "/api/goals", {
    brief: { title: "保持监控", objective: "验证长期目标在重启后可恢复。" },
    scope: "background",
    requestId: "goal-recover-1"
  });
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  const programId = goal.body.programId;
  const paused = await api(root, "POST", `/api/tasks/${goal.body.taskId}/goals/${programId}/control`, {
    action: "pause",
    revision: goal.body.goal.revision
  });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.status, "paused");

  const stopped = await stopBackend(root.env);
  assert.equal(stopped.state, "stopped");
  assert.equal(alive(started.pid), false);

  const restarted = await startBackend(root.env);
  assert.equal(restarted.backendId, started.backendId);
  const afterRestart = await api(root, "GET", "/api/tasks/daemon-task");
  const recoveredJob = afterRestart.body.jobs.find((entry) => entry.jobId === "job-1");
  assert.ok(recoveredJob, JSON.stringify(afterRestart.body.jobs));
  assert.equal(recoveredJob.state, "exited");
  assert.equal(recoveredJob.logPath, job.logPath);

  const goals = await api(root, "GET", "/api/goals");
  const recoveredGoal = goals.body.goals.find((entry) => entry.programId === programId);
  assert.ok(recoveredGoal, JSON.stringify(goals.body.goals));
  assert.equal(recoveredGoal.status, "paused");
  assert.equal(recoveredGoal.goal.revision, paused.body.goal.revision);
  const resumed = await api(root, "POST", `/api/tasks/${goal.body.taskId}/goals/${programId}/control`, {
    action: "resume",
    revision: recoveredGoal.goal.revision
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.notEqual(resumed.body.status, "paused");
});
