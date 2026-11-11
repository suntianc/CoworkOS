import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { MAIN_CONTINUATION_COMMAND } from "../dist/src/runtime/main-continuation.js";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

test(
  "real Pi internal continuation cancels idle learning without a before_agent_start hook",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-memory-foreground-pi-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    const hooksPath = join(root, "hooks.jsonl");
    const probePath = join(root, "hook-probe.ts");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    await writeFile(
      probePath,
      `import { appendFile } from "node:fs/promises";
       export default function (pi) {
         for (const name of ["before_agent_start", "agent_start"])
           pi.on(name, async () => { await appendFile(${JSON.stringify(hooksPath)}, name + "\\n"); });
       }`
    );
    const store = new UserMemoryStore(join(root, "home", "memory", "user-memory.json"));
    await store.setEnabled(true);
    await store.setLearningEnabled(true);
    await store.enqueueLearning(
      { taskId: "older-task", runId: "older-run", text: "我平时写工作邮件更喜欢简洁的中文。" },
      0
    );
    const mainRequests = [];
    let extractionStarted = false;
    let extractionCancelled = false;
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "protocol-fixture" }] }));
        return;
      }
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(body.stream, true);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (JSON.stringify(body.messages).includes("Extract durable USER memory")) {
        response.once("close", () => {
          if (!response.writableEnded) extractionCancelled = true;
        });
        response.flushHeaders();
        extractionStarted = true;
        // Leave the learner's response pending. The continuation must abort it
        // while the normal Main request still produces a complete response.
        return;
      }
      mainRequests.push(body);
      response.end(
        protocolStream("openai-completions", {
          text: mainRequests.length === 1 ? "INITIAL_TURN_COMPLETE" : "INTERNAL_CONTINUATION_COMPLETE"
        })
      );
    });
    let child;
    let closed;
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 2000);
        await closed;
        clearTimeout(force);
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(COWORK_|ATRIA_|PI_|SERPER_|EXA_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
            key
          )
      )
    );
    Object.assign(env, {
      ATRIA_HOME: join(root, "home"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: workspace,
      COWORK_PROJECT_DIR: project,
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_TASK_ID: "current-task",
      COWORK_RUN_ID: "current-run",
      COWORK_MAIN_CONTINUATION: join(root, "main-input.json"),
      COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
      COWORK_API_KEY: "fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_MODEL_API: "openai-completions",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_WEB_TOOLS: "0",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    });
    child = spawn(
      process.execPath,
      [
        "scripts/atria.mjs",
        "--mode",
        "rpc",
        "--session-dir",
        join(root, "sessions"),
        "--extension",
        resolve(".pi/extensions/cowork.ts"),
        "--extension",
        probePath
      ],
      { cwd: resolve("."), env, stdio: "pipe" }
    );
    closed = new Promise((done) => child.once("close", done));
    const rows = [];
    let buffer = "";
    let stderr = "";
    let parseError;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try {
          rows.push(JSON.parse(line));
        } catch (error) {
          parseError = error;
        }
      }
    });
    const wait = async (predicate, label, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      while (!(await predicate())) {
        assert.equal(parseError, undefined, "RPC stdout must stay JSONL");
        if (child.exitCode !== null || Date.now() >= deadline)
          assert.fail(`${label}: ${stderr}\n${JSON.stringify(rows.slice(-8))}`);
        await delay(20);
      }
    };
    const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
    send({ id: "ready", type: "get_state" });
    await wait(() => rows.some((row) => row.id === "ready" && row.success), "RPC session did not start");
    send({ id: "initial", type: "prompt", message: "回复一句简短问候。" });
    await wait(() => rows.some((row) => row.type === "agent_end"), "initial foreground turn did not finish");
    assert.equal(mainRequests.length, 1);
    const quietPath = `${store.path}.quiet.json`;
    let quiet;
    await wait(async () => {
      try {
        quiet = JSON.parse(await readFile(quietPath, "utf8"));
        return quiet.availableAt > Date.now();
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, "initial foreground turn did not publish its quiet window");
    // Advance only this fixture's persisted clock past the idle minute. The
    // quiet-window duration has separate coverage; this case keeps the real timer.
    await writeFile(quietPath, JSON.stringify({ ...quiet, availableAt: Date.now() - 1 }));
    // The production service checks idle work every 15 seconds. Keep the real
    // RPC host alive so this exercises its timer and the SDK's internal turn path.
    await wait(() => extractionStarted, "idle learning did not start", 20000);
    assert.equal(extractionCancelled, false);
    const before = (await store.read()).pending.find((item) => item.taskId === "older-task");
    assert.ok(before);
    send({ id: "continue", type: "prompt", message: MAIN_CONTINUATION_COMMAND });
    await wait(
      () => rows.some((row) => row.id === "continue" && row.type === "response" && row.success),
      "internal continuation did not finish"
    );
    await wait(() => extractionCancelled, "internal continuation did not cancel idle learning", 2000);
    assert.equal(mainRequests.length, 2);
    assert.ok(JSON.stringify(rows).includes("INTERNAL_CONTINUATION_COMPLETE"));
    const hooks = (await readFile(hooksPath, "utf8")).trim().split("\n");
    assert.equal(hooks.filter((name) => name === "before_agent_start").length, 1);
    assert.equal(hooks.filter((name) => name === "agent_start").length, 2);
    const after = (await store.read()).pending.find((item) => item.taskId === "older-task");
    assert.ok(after, "cancelled extraction must retain the older user's input");
    assert.equal(after.attempts, before.attempts);
    assert.equal(after.lastError, undefined);
    assert.ok(!JSON.stringify(mainRequests[1]).includes(MAIN_CONTINUATION_COMMAND));
    child.stdin.end();
    await closed;
    assert.equal(child.exitCode, 0, stderr);
  }
);
