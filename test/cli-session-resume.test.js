import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const exec = promisify(execFile);
const entry = resolve(process.env.ATRIA_TEST_CLI_ENTRY || "scripts/atria.mjs");
const commandTimeoutMs = 15_000;
const killGraceMs = 2_000;

test(
  "CLI continuation and explicit session selection preserve the original Task and project",
  // Fourteen serial CLI launches each retain their own deadline, even when
  // other Node files compete for startup CPU. Include fixture setup/cleanup.
  { timeout: commandTimeoutMs * 14 + killGraceMs + 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-cli-resume-"));
    const project = join(root, "project"),
      other = join(root, "other"),
      user = join(root, "user");
    const children = new Set();
    let server;
    t.after(async () => {
      for (const { stop } of children) stop();
      await Promise.all([...children].map(({ closed }) => closed));
      if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      await rm(root, { recursive: true, force: true });
    });
    await Promise.all([mkdir(project), mkdir(other), mkdir(user)]);
    const requests = [];
    server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "resume", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant", content: "Session response recorded." });
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
    );
    Object.assign(env, {
      ATRIA_HOME: user,
      COWORK_API_KEY: "resume-fixture-key",
      COWORK_MODEL_API: "openai-completions",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    });
    const run = async (args, extra = {}, cwd = project) => {
      const pending = exec(process.execPath, [entry, ...args], {
        cwd,
        env: { ...env, ...extra },
        timeout: commandTimeoutMs,
        signal: t.signal,
        maxBuffer: 1024 * 1024
      });
      let stopped = false;
      let forceKillTimer = setTimeout(() => pending.child.kill("SIGKILL"), commandTimeoutMs + killGraceMs);
      forceKillTimer.unref();
      const stop = () => {
        if (stopped) return;
        stopped = true;
        pending.child.kill("SIGTERM");
        clearTimeout(forceKillTimer);
        forceKillTimer = setTimeout(() => pending.child.kill("SIGKILL"), killGraceMs);
        forceKillTimer.unref();
      };
      const closed = new Promise((done) =>
        pending.child.once("close", () => {
          clearTimeout(forceKillTimer);
          t.signal.removeEventListener("abort", stop);
          done();
        })
      );
      t.signal.addEventListener("abort", stop, { once: true });
      if (t.signal.aborted) stop();
      const running = { stop, closed };
      children.add(running);
      pending.child.stdin.end();
      try {
        return await pending;
      } finally {
        await closed;
        children.delete(running);
      }
    };
    const prompt = (text, options = []) => ["start", "--approve", "--mode", "json", "-p", ...options, text];
    await run(["init", "--base-url", `http://127.0.0.1:${server.address().port}/v1`, "--model", "fixture"]);
    const workspace = join(user, "workspace");
    const tasks = async () =>
      (await readdir(workspace, { withFileTypes: true }))
        .filter((item) => item.isDirectory() && item.name.startsWith("task-"))
        .map((item) => item.name);
    await run(prompt("First project session."));
    const [taskId] = await tasks();
    assert.ok(taskId);
    await run(prompt("Continue this project session.", ["--continue"]));
    assert.deepEqual(
      await tasks(),
      [taskId],
      "--continue must restore the Task as well as the Pi transcript"
    );
    assert.ok(
      requests
        .at(-1)
        .messages.some(
          (message) =>
            message.role === "user" && JSON.stringify(message.content).includes("First project session.")
        )
    );
    const directories = await readdir(join(user, "pi", "sessions"));
    const files = await readdir(join(user, "pi", "sessions", directories[0]));
    const sessionFile = join(
      user,
      "pi",
      "sessions",
      directories[0],
      files.find((file) => file.endsWith(".jsonl"))
    );
    const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]);
    await run(prompt("Continue by UUID.", ["--session", header.id]));
    await run(prompt("Continue by file.", ["--session", sessionFile]));
    assert.deepEqual(await tasks(), [taskId]);
    await run(prompt("A separate project must stay separate.", ["--continue"]), {}, other);
    assert.equal((await tasks()).length, 2);
    await run(prompt("Use an explicit Task.", ["--session", sessionFile]), {
      COWORK_TASK_ID: "explicit-resume"
    });
    assert.equal(
      JSON.parse(await readFile(join(workspace, "explicit-resume", "task.json"), "utf8")).taskId,
      "explicit-resume"
    );
    await run(prompt("Keep the explicit Task after restarting.", ["--session", header.id]));
    assert.equal((await readdir(workspace)).filter((name) => name.startsWith("task-")).length, 2);
    assert.match((await run(["task", "list"])).stdout, /explicit-resume/);
    const customDirectory = join(other, "session-cache");
    await run(prompt("A custom session directory.", ["--session-dir", customDirectory]));
    const [customFile] = (await readdir(customDirectory)).filter((file) => file.endsWith(".jsonl"));
    await run(
      prompt("Resume with a relative directory from another cwd.", [
        "--session-dir",
        "ignored-first",
        "--session-dir",
        "session-cache",
        "--session",
        join(customDirectory, customFile),
        "--",
        "--session-dir",
        "literal-prompt-directory"
      ]),
      {},
      other
    );
    await assert.rejects(
      stat(join(project, "session-cache")),
      { code: "ENOENT" },
      "relative --session-dir must stay anchored to the original invocation cwd"
    );
    await assert.rejects(stat(join(project, "ignored-first")), { code: "ENOENT" });
    const explicitTaskFile = join(workspace, "explicit-resume", "task.json");
    await writeFile(
      explicitTaskFile,
      JSON.stringify({ ...JSON.parse(await readFile(explicitTaskFile, "utf8")), projectDirectory: other })
    );
    const taskBefore = await readFile(explicitTaskFile, "utf8"),
      historyBefore = await readFile(sessionFile, "utf8"),
      requestCount = requests.length;
    await assert.rejects(
      run(prompt("Reject a conflicting project.", ["--session", sessionFile]), {
        COWORK_TASK_ID: "explicit-resume"
      }),
      (error) => /project.*session|项目.*会话/.test(error.stderr)
    );
    assert.equal(await readFile(explicitTaskFile, "utf8"), taskBefore);
    assert.equal(await readFile(sessionFile, "utf8"), historyBefore);
    assert.equal(requests.length, requestCount);
    const sharedDirectory = join(root, "shared-session-history");
    await run(
      prompt("Foreign shared-directory history.", ["--session-dir", sharedDirectory]),
      { COWORK_TASK_ID: "foreign-shared" },
      other
    );
    const [foreignFile] = (await readdir(sharedDirectory)).filter((file) => file.endsWith(".jsonl"));
    const foreignPath = join(sharedDirectory, foreignFile),
      foreignBefore = await readFile(foreignPath, "utf8");
    await new LocalWorkspaceStore(workspace).createTask("guarded-project", {
      goal: "Keep this project's task isolated",
      projectDirectory: project
    });
    await run(
      prompt("A clean continuation of this project.", ["--continue", "--session-dir", sharedDirectory]),
      { COWORK_TASK_ID: "guarded-project" }
    );
    assert.ok(!JSON.stringify(requests.at(-1).messages).includes("Foreign shared-directory history."));
    assert.equal(await readFile(foreignPath, "utf8"), foreignBefore);
    assert.ok(
      !(
        await readFile(join(workspace, "guarded-project", "agents/main/context/messages.json"), "utf8")
      ).includes("Foreign shared-directory history.")
    );
  }
);
