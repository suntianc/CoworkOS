import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

/**
 * Authorized local clients driving management commands against a real backend.
 *
 * Every case starts the standalone backend from its entry, gets a local session
 * from the running process and changes real projects, tasks and goals through
 * the same HTTP API the desktop and Web clients use. The point is the protocol
 * seam: who may act, what a repeated command returns, and what survives a lost
 * response and a real restart.
 */

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const backendEntry = join(repositoryRoot, "dist/src/cli/backend.js");

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

async function createRoot(prefix) {
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
    COWORK_SUPERVISOR_INTERVAL_MS: "1000"
  });
  return { base, home, workspace, project, userHome, configPath, env };
}

function runProcess(entry, args, env, timeoutMs = 60_000) {
  const child = spawn(entry, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
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

async function backendCommand(args, env) {
  const result = await runProcess(process.execPath, [backendEntry, ...args], env);
  assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.err || result.out}`);
  return JSON.parse(result.out);
}

const startBackend = (env) => backendCommand(["start"], env);
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

async function api(root, method, path, body, credential) {
  const instance = await readInstance(root);
  const token = credential === undefined ? instance.token : credential;
  const headers = {};
  if (token) headers["x-atria-token"] = token;
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
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) };
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

async function authorize(root, clientName, credential) {
  const created = await api(root, "POST", "/api/session", { clientName, protocolVersion: "1.0" }, credential);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.session;
}

async function stopQuietly(root) {
  try {
    await runProcess(process.execPath, [backendEntry, "stop"], root.env);
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

test(
  "a local session reads backend protocol and capabilities, and revocation ends it",
  { timeout: 90_000 },
  async (t) => {
    const root = await createRoot("atria-mgmt-session-");
    t.after(async () => {
      await stopQuietly(root);
      await rm(root.base, { recursive: true, force: true });
    });
    await startBackend(root.env);

    // No credential and an unknown credential are refused before any business work.
    const anonymous = await api(root, "GET", "/api/backend", undefined, "");
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));
    assert.equal(anonymous.body.code, "unauthorized");
    const forged = await api(root, "GET", "/api/backend", undefined, "not-a-real-session");
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, "unauthorized");
    const refusedCreate = await api(root, "POST", "/api/session", { protocolVersion: "1.0" }, "");
    assert.equal(refusedCreate.status, 401, "a session cannot be minted without a local credential");

    // The host credential is the instance token; it mints a named local session.
    const session = await authorize(root, "回归客户端");
    assert.ok(session.sessionId);
    assert.ok(session.token);
    assert.notEqual(session.token, (await readInstance(root)).token, "a session has its own credential");

    const info = await api(root, "GET", "/api/backend", undefined, session.token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.backendId, (await readInstance(root)).backendId);
    assert.equal(info.body.protocol.version, "1.0");
    assert.equal(info.body.protocol.minClientVersion, "1.0");
    for (const capability of [
      "protocol.negotiate",
      "session.authorize",
      "session.revoke",
      "operations.query",
      "commands.idempotent",
      "commands.expectedRevision"
    ])
      assert.ok(info.body.protocol.capabilities.includes(capability), capability);

    // An authorized session performs ordinary management reads.
    assert.equal((await api(root, "GET", "/api/tasks", undefined, session.token)).status, 200);

    // A client speaking an incompatible protocol is told why, and a legacy one that
    // names no protocol is asked for it instead of guessing.
    const tooNew = await api(root, "POST", "/api/session", { protocolVersion: "2.0" });
    assert.equal(tooNew.status, 409, JSON.stringify(tooNew.body));
    assert.equal(tooNew.body.code, "protocol_incompatible");
    assert.match(tooNew.body.error, /2\.0/);
    assert.match(tooNew.body.error, /1\.0/);
    const unspecified = await api(root, "POST", "/api/session", {});
    assert.equal(unspecified.status, 400, JSON.stringify(unspecified.body));
    assert.equal(unspecified.body.code, "protocol_required");
    const second = await authorize(root, "第二个客户端");
    const delegated = await api(root, "POST", "/api/session", { protocolVersion: "1.0" }, session.token);
    assert.equal(delegated.status, 403, "a session cannot mint another session");
    assert.equal(delegated.body.code, "host_credential_required");

    // The host sees every live session; each session sees the local sessions it may act on.
    const listed = await api(root, "GET", "/api/session");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.sessions.map((entry) => entry.sessionId).sort(),
      [session.sessionId, second.sessionId].sort()
    );
    assert.ok(
      listed.body.sessions.every((entry) => entry.token === undefined),
      "listing never repeats secrets"
    );

    // Revocation is immediate and explicit for the revoked credential only.
    const revoked = await api(root, "DELETE", `/api/session/${session.sessionId}`, undefined, session.token);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.revoked, true);
    const afterRevoke = await api(root, "GET", "/api/tasks", undefined, session.token);
    assert.equal(afterRevoke.status, 401, "the next operation of a revoked session fails");
    assert.equal(afterRevoke.body.code, "session_revoked");
    const otherStillWorks = await api(root, "GET", "/api/tasks", undefined, second.token);
    assert.equal(otherStillWorks.status, 200, "revoking one client keeps the owner's other clients");
    assert.equal((await api(root, "DELETE", `/api/session/${session.sessionId}`)).status, 200);
    assert.equal(
      (await api(root, "DELETE", "/api/session/session_missing")).status,
      404,
      "revoking an unknown session is not a silent success"
    );
    assert.equal((await api(root, "GET", "/api/backend", undefined, second.token)).status, 200);
  }
);

test(
  "a repeated command replays its result, refuses different content, and a stale revision cannot overwrite",
  { timeout: 120_000 },
  async (t) => {
    const root = await createRoot("atria-mgmt-command-");
    t.after(async () => {
      await stopQuietly(root);
      await rm(root.base, { recursive: true, force: true });
    });
    await startBackend(root.env);
    const client = await authorize(root, "命令客户端");
    const other = await authorize(root, "第二个客户端");

    // A real project is created exactly once, and the retry returns that result.
    const projectBody = {
      projectName: "受管项目",
      projectDirectory: root.project,
      operationId: "op-project-create"
    };
    const created = await api(root, "POST", "/api/projects", projectBody, client.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    assert.ok(project.projectId);
    assert.equal(created.headers["x-cowork-replayed"], undefined);

    const replay = await api(root, "POST", "/api/projects", projectBody, client.token);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.headers["x-cowork-replayed"], "1");
    assert.deepEqual(replay.body, created.body, "the retry returns the saved result");
    const afterReplay = await api(root, "GET", "/api/tasks", undefined, client.token);
    assert.equal(
      afterReplay.body.projects.filter((entry) => entry.projectDirectory === root.project).length,
      1,
      "the retry created no second project"
    );

    // Two in-flight duplicates of one command still produce one result.
    const concurrentDirectory = join(root.base, "concurrent-project");
    await mkdir(concurrentDirectory, { recursive: true });
    const concurrentBody = {
      projectName: "并发项目",
      projectDirectory: concurrentDirectory,
      operationId: "op-concurrent-create"
    };
    const concurrent = await Promise.all([
      api(root, "POST", "/api/projects", concurrentBody, client.token),
      api(root, "POST", "/api/projects", concurrentBody, client.token)
    ]);
    assert.deepEqual(
      concurrent.map((entry) => entry.status),
      [201, 201],
      JSON.stringify(concurrent.map((entry) => entry.body))
    );
    assert.equal(
      concurrent.filter((entry) => entry.headers["x-cowork-replayed"] === "1").length,
      1,
      "exactly one attempt applied the command"
    );
    assert.deepEqual(concurrent[0].body, concurrent[1].body);
    const afterConcurrent = await api(root, "GET", "/api/tasks", undefined, client.token);
    assert.equal(
      afterConcurrent.body.projects.filter((entry) => entry.projectDirectory === concurrentDirectory).length,
      1
    );

    // The same operation id with different content is refused before it changes state.
    const changed = await api(
      root,
      "POST",
      "/api/projects",
      { ...projectBody, projectName: "另一个项目" },
      client.token
    );
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.code, "operation_conflict");
    const afterConflict = await api(root, "GET", "/api/tasks", undefined, client.token);
    assert.equal(
      afterConflict.body.projects.filter((entry) => entry.projectDirectory === root.project).length,
      1
    );
    assert.equal(
      afterConflict.body.projects.some((entry) => entry.projectName === "另一个项目"),
      false,
      "the refused command created nothing"
    );

    // Receipts belong to the identity that sent the command.
    const ownReceipt = await api(root, "GET", "/api/operations/op-project-create", undefined, client.token);
    assert.equal(ownReceipt.status, 200, JSON.stringify(ownReceipt.body));
    assert.equal(ownReceipt.body.command, "projects.create");
    assert.equal(ownReceipt.body.status, 201);
    assert.deepEqual(ownReceipt.body.body, created.body);
    const foreignReceipt = await api(
      root,
      "GET",
      "/api/operations/op-project-create",
      undefined,
      other.token
    );
    assert.equal(foreignReceipt.status, 404, "one client never reads another client's receipt");
    assert.equal(foreignReceipt.body.code, "operation_unknown");
    const unknownReceipt = await api(root, "GET", "/api/operations/op-never-sent", undefined, client.token);
    assert.equal(unknownReceipt.status, 404);
    assert.equal(unknownReceipt.body.code, "operation_unknown");

    // Operation ids must be usable as command identity, not as free text.
    const invalidId = await api(
      root,
      "POST",
      "/api/projects",
      { projectName: "无效编号", projectDirectory: root.project, operationId: "bad id!" },
      client.token
    );
    assert.equal(invalidId.status, 400, JSON.stringify(invalidId.body));
    assert.equal(invalidId.body.code, "operation_id_invalid");

    // A second client reusing an operation id runs its own command: identity is
    // part of the key, so one client's retry never answers another's request.
    const secondDirectory = join(root.base, "second-project");
    await mkdir(secondDirectory, { recursive: true });
    const second = await api(
      root,
      "POST",
      "/api/projects",
      {
        projectName: "第二个客户端的项目",
        projectDirectory: secondDirectory,
        operationId: "op-project-create"
      },
      other.token
    );
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.project.projectId, project.projectId);
    assert.equal(second.body.project.projectName, "第二个客户端的项目");

    // Renaming an existing project is a real object change; a replay reports the
    // saved result and does not run the rename again.
    const renameBody = { projectName: "受管项目（已重命名）", operationId: "op-project-rename" };
    const renamed = await api(root, "PATCH", `/api/projects/${project.projectId}`, renameBody, client.token);
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.project.projectName, "受管项目（已重命名）");
    const renameReplay = await api(
      root,
      "PATCH",
      `/api/projects/${project.projectId}`,
      renameBody,
      client.token
    );
    assert.equal(renameReplay.headers["x-cowork-replayed"], "1");
    assert.deepEqual(renameReplay.body, renamed.body);
    const renameConflict = await api(
      root,
      "PATCH",
      `/api/projects/${project.projectId}`,
      { projectName: "第三种名字", operationId: "op-project-rename" },
      client.token
    );
    assert.equal(renameConflict.status, 409, JSON.stringify(renameConflict.body));
    assert.equal(renameConflict.body.code, "operation_conflict");
    const afterRenameConflict = await api(root, "GET", "/api/tasks", undefined, client.token);
    const renamedProject = afterRenameConflict.body.projects.find(
      (entry) => entry.projectId === project.projectId
    );
    assert.equal(renamedProject.projectName, "受管项目（已重命名）", "the refused retry did not rename");

    // Task creation through the same command layer: without the operation id a
    // second identical request is a real duplicate, so the replay is what makes
    // the retry succeed with one Task.
    const taskBody = {
      taskId: "managed-task",
      goal: "验收受管任务",
      projectId: project.projectId,
      operationId: "op-task-create"
    };
    const task = await api(root, "POST", "/api/tasks", taskBody, client.token);
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal(task.body.taskId, "managed-task");
    const taskReplay = await api(root, "POST", "/api/tasks", taskBody, client.token);
    assert.equal(taskReplay.status, 201, JSON.stringify(taskReplay.body));
    assert.equal(taskReplay.headers["x-cowork-replayed"], "1");
    assert.deepEqual(taskReplay.body, task.body);
    const taskConflict = await api(
      root,
      "POST",
      "/api/tasks",
      { ...taskBody, goal: "另一件任务" },
      client.token
    );
    assert.equal(taskConflict.status, 409, JSON.stringify(taskConflict.body));
    assert.equal(taskConflict.body.code, "operation_conflict");
    const duplicate = await api(
      root,
      "POST",
      "/api/tasks",
      { taskId: "managed-task", goal: "验收受管任务", projectId: project.projectId },
      client.token
    );
    assert.equal(duplicate.status, 409, "an unmarked duplicate is still refused by the business service");
    const detail = await api(root, "GET", "/api/tasks/managed-task", undefined, client.token);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.task.goal, "验收受管任务", "the refused retry did not change the Task");

    // A command that generates its own Task id stays one Task on retry: the
    // client never has to learn the id before it repeats the request.
    const generatedBody = {
      goal: "自动编号的任务",
      projectId: project.projectId,
      operationId: "op-generated-task"
    };
    const generated = await api(root, "POST", "/api/tasks", generatedBody, client.token);
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    const generatedRetry = await api(root, "POST", "/api/tasks", generatedBody, client.token);
    assert.equal(generatedRetry.headers["x-cowork-replayed"], "1");
    assert.equal(generatedRetry.body.taskId, generated.body.taskId);
    assert.deepEqual(generatedRetry.body, generated.body);

    // A goal carries its own revision: the expected revision guards the change
    // and the saved command result outlives it.
    const goal = await api(
      root,
      "POST",
      "/api/goals",
      {
        brief: { title: "受管目标", objective: "验证旧修订不能覆盖新状态" },
        scope: "background",
        requestId: "managed-goal-1"
      },
      client.token
    );
    assert.equal(goal.status, 201, JSON.stringify(goal.body));
    const goalTaskId = goal.body.taskId;
    const programId = goal.body.programId;
    assert.equal(goal.body.goal.revision, 1);
    const control = (body) =>
      api(root, "POST", `/api/tasks/${goalTaskId}/goals/${programId}/control`, body, client.token);

    const pause = await control({ action: "pause", revision: 1, operationId: "op-goal-pause" });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    assert.equal(pause.body.status, "paused");
    assert.equal(pause.body.goal.revision, 2);
    const pauseReplay = await control({ action: "pause", revision: 1, operationId: "op-goal-pause" });
    assert.equal(pauseReplay.status, 200, "the saved result stands even though the revision moved");
    assert.equal(pauseReplay.headers["x-cowork-replayed"], "1");
    assert.deepEqual(pauseReplay.body, pause.body);

    const stale = await control({ action: "resume", revision: 1, operationId: "op-goal-resume-stale" });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "revision_conflict");
    const unchanged = await api(
      root,
      "GET",
      `/api/tasks/${goalTaskId}/goals/${programId}`,
      undefined,
      client.token
    );
    assert.equal(unchanged.body.status, "paused", "a stale revision did not resume the goal");
    assert.equal(unchanged.body.goal.revision, 2);

    const resumed = await control({ action: "resume", revision: 2, operationId: "op-goal-resume" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.goal.revision, 3);
    assert.equal(resumed.body.status, "monitoring");
  }
);

/** One raw HTTP/1.1 request, for the cases fetch cannot express. */
function requestText(instance, { method, path, headers = {}, body = "" }) {
  const host = headers.host ?? `127.0.0.1:${instance.port}`;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close"];
  if (body) {
    lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`);
  }
  for (const [name, value] of Object.entries(headers)) if (name !== "host") lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

async function rawRequest(instance, options) {
  const socket = connect(instance.port, "127.0.0.1");
  socket.setEncoding("utf8");
  return new Promise((resolveRequest, reject) => {
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw request timed out: ${data}`));
    }, 5_000);
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const status = Number(data.split("\r\n")[0]?.split(" ")[1]);
      resolveRequest({ status, raw: data });
    });
    socket.on("connect", () => socket.write(requestText(instance, options)));
  });
}

async function listenerAccepts(port, address) {
  const socket = connect(port, address);
  return new Promise((resolveListen) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolveListen(false);
    }, 3_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveListen(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolveListen(false);
    });
  });
}

function externalIPv4() {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && /^en\d+$/.test(name)) return address.address;
    }
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."))
        return address.address;
    }
  }
  return undefined;
}

test(
  "a saved command survives a lost response and a real restart, and the local boundary stays closed",
  { timeout: 150_000 },
  async (t) => {
    const root = await createRoot("atria-mgmt-restart-");
    t.after(async () => {
      await stopQuietly(root);
      await rm(root.base, { recursive: true, force: true });
    });
    await startBackend(root.env);
    const session = await authorize(root, "断线客户端");
    const project = await api(
      root,
      "POST",
      "/api/projects",
      { projectName: "重试项目", projectDirectory: root.project, operationId: "op-project" },
      session.token
    );
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const create = {
      taskId: "lost-task",
      goal: "丢失响应后仍然只有一件任务",
      projectId: project.body.project.projectId,
      operationId: "op-lost-create"
    };
    const instance = await readInstance(root);

    // The client sends the command and loses the connection before reading the
    // response: the server keeps working and saves the result.
    const abandoned = connect(instance.port, "127.0.0.1");
    abandoned.setEncoding("utf8");
    abandoned.on("data", () => {
      /* the response has no reader: this is the lost response */
    });
    abandoned.on("error", () => {
      /* the socket is destroyed on purpose */
    });
    await new Promise((done) => abandoned.on("connect", done));
    abandoned.write(
      requestText(instance, {
        method: "POST",
        path: "/api/tasks",
        headers: { "x-atria-token": session.token },
        body: JSON.stringify(create)
      })
    );
    await delay(300);
    abandoned.destroy();
    const saved = await waitFor("the command result to be saved", async () => {
      const receipt = await api(root, "GET", "/api/operations/op-lost-create", undefined, session.token);
      return receipt.status === 200 ? receipt.body : undefined;
    });
    assert.equal(saved.status, 201, JSON.stringify(saved));
    assert.equal(saved.command, "tasks.create");
    assert.equal(saved.body.taskId, "lost-task");
    const beforeCrash = await api(root, "GET", "/api/tasks/lost-task", undefined, session.token);
    assert.equal(beforeCrash.status, 200);
    assert.equal(beforeCrash.body.task.goal, create.goal);

    // A crash, not a graceful stop: the records on disk are the recovery.
    process.kill(instance.pid, "SIGKILL");
    await waitFor("the crashed backend to exit", async () => !alive(instance.pid), 10_000);
    const restarted = await startBackend(root.env);
    assert.equal(restarted.backendId, instance.backendId, "the same backend identity comes back");
    assert.notEqual(restarted.pid, instance.pid);
    const restartedInstance = await readInstance(root);

    // The session belongs to the data root, so the same client continues.
    const afterRestartReceipt = await api(
      root,
      "GET",
      "/api/operations/op-lost-create",
      undefined,
      session.token
    );
    assert.equal(afterRestartReceipt.status, 200, "the receipt outlived the process");
    assert.deepEqual(afterRestartReceipt.body, saved);
    const retry = await api(root, "POST", "/api/tasks", create, session.token);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(retry.headers["x-cowork-replayed"], "1");
    assert.deepEqual(retry.body, saved.body);
    const reconnected = await api(root, "GET", "/api/tasks/lost-task", undefined, session.token);
    assert.equal(reconnected.status, 200);
    assert.equal(
      reconnected.body.task.createdAt,
      beforeCrash.body.task.createdAt,
      "the retry returned the original Task, not a second one"
    );

    // The local boundary is unchanged: loopback only, with Host/Origin checks.
    assert.match(
      restartedInstance.url,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      "the backend publishes a loopback URL"
    );
    const external = externalIPv4();
    if (external) {
      assert.equal(
        await listenerAccepts(restartedInstance.port, external),
        false,
        `the backend must not listen on the non-loopback address ${external}`
      );
    }
    const token = session.token;
    const allowed = await rawRequest(restartedInstance, {
      method: "GET",
      path: "/api/backend",
      headers: { host: `localhost:${restartedInstance.port}`, "x-atria-token": token }
    });
    assert.equal(allowed.status, 200, allowed.raw);
    const foreignHost = await rawRequest(restartedInstance, {
      method: "GET",
      path: "/api/backend",
      headers: { host: `attacker.invalid:${restartedInstance.port}`, "x-atria-token": token }
    });
    assert.equal(foreignHost.status, 403, foreignHost.raw);
    const foreignOrigin = await rawRequest(restartedInstance, {
      method: "GET",
      path: "/api/backend",
      headers: { origin: "http://attacker.invalid", "x-atria-token": token }
    });
    assert.equal(foreignOrigin.status, 403, foreignOrigin.raw);
    const crossSite = await rawRequest(restartedInstance, {
      method: "GET",
      path: "/api/backend",
      headers: { "sec-fetch-site": "cross-site", "x-atria-token": token }
    });
    assert.equal(crossSite.status, 403, crossSite.raw);
    const noCredential = await rawRequest(restartedInstance, { method: "GET", path: "/api/backend" });
    assert.equal(noCredential.status, 401, noCredential.raw);
  }
);
