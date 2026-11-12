import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const harnessRoot = resolve(process.env.ATRIA_TEST_HARNESS_ROOT ?? ".");
const nodeExecutable = process.env.ATRIA_TEST_NODE_BIN ?? process.execPath;
const { MainInboxDelivery } = await import(
  pathToFileURL(join(harnessRoot, "dist/src/runtime/main-inbox-delivery.js")).href
);
const { LocalWorkspaceStore } = await import(
  pathToFileURL(join(harnessRoot, "dist/src/workspace/workspace-store.js")).href
);

for (const alphaFails of [true, false]) {
  test(
    alphaFails
      ? "a late successful callback survives Main provider failure and disposed extension UI"
      : "periodic Inbox delivery cannot kill another child after Main has stopped",
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-callback-lifecycle-"));
      const taskId = "task",
        runId = "run";
      const project = join(root, taskId, "inputs"),
        agentDir = join(root, "pi-agent");
      await mkdir(project, { recursive: true });
      await mkdir(agentDir);
      await writeFile(join(root, "config.json"), "{}");
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
          compaction: { enabled: false }
        })
      );
      const checkers = {};
      for (const label of ["ALPHA", "BETA"]) {
        checkers[label] = join(project, `check-${label.toLowerCase()}.mjs`);
        await writeFile(
          checkers[label],
          `import assert from 'node:assert/strict'; const result = 6 * 7; assert.equal(result, 42); console.log('${label}_RESULT=' + result); console.log('${label}_ASSERTIONS=passed');`
        );
      }
      const store = new LocalWorkspaceStore(root);
      await store.createTask(taskId);
      await store.createRun(taskId, runId);
      const preload = join(root, "budget.mjs");
      await writeFile(
        preload,
        `import { CoordinatorRuntime } from ${JSON.stringify(pathToFileURL(join(harnessRoot, "dist/src/runtime/coordinator-runtime.js")).href)}; const dispatch = CoordinatorRuntime.prototype.dispatch; CoordinatorRuntime.prototype.dispatch = function(input) { return dispatch.call(this, { ...input, maxErrorRetries: 0 }); };`
      );
      const requests = { main: 0, ALPHA: 0, BETA: 0 };
      const serverErrors = [];
      const model = "callback-lifecycle-fixture";
      const provider = createServer(async (request, response) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const systems = body.messages
            .filter((message) => ["system", "developer"].includes(message.role))
            .map((message) => JSON.stringify(message.content))
            .join("\n");
          const subagent = systems.includes("You are a CoworkOS Subagent");
          const assigned = body.messages.find(
            (message) =>
              message.role === "user" && JSON.stringify(message.content).includes("Main 分配的任务")
          );
          const label = subagent
            ? JSON.stringify(assigned.content).includes("Main 分配的任务：[ALPHA]")
              ? "ALPHA"
              : "BETA"
            : "main";
          requests[label] += 1;
          assert.equal(body.model, model);
          assert.ok(requests[label] <= 4);
          if ((label === "ALPHA" && alphaFails) || (label === "main" && requests.main > 1)) {
            response.writeHead(429, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: {
                  message: "Synthetic cluster RPM rate limit exceeded.",
                  type: "invalid_request_error"
                }
              })
            );
            return;
          }
          const reply = ({ text, calls }) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            const send = (delta, finish_reason = null) =>
              response.write(
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
              );
            send({ role: "assistant" });
            if (calls)
              send({
                tool_calls: calls.map(([name, args], index) => ({
                  index,
                  id: `${label}-${requests[label]}-${index}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) }
                }))
              });
            else send({ content: text });
            send({}, calls ? "tool_calls" : "stop");
            response.end("data: [DONE]\n\n");
          };
          if (label === "main")
            return reply({
              calls: [
                ["call_subagent", { task: "[ALPHA] Return a short result", mode: "async" }],
                ["call_subagent", { task: "[BETA] Run the provided synthetic checker", mode: "async" }]
              ]
            });
          if (requests[label] === 1)
            return reply({ calls: [["run_tests", { command: nodeExecutable, args: [checkers[label]] }]] });
          // Let --print settle and dispose Main's context before this child finishes.
          await new Promise((done) => setTimeout(done, label === "ALPHA" ? 4500 : 1200));
          reply({ text: `${label}_RESULT=42; ${label}_ASSERTIONS=passed` });
        } catch (error) {
          serverErrors.push(error);
          response.destroy();
        }
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("COWORK_") && !name.startsWith("SERPER_") && name !== "NODE_OPTIONS"
        )
      );
      const child = spawn(
        nodeExecutable,
        [
          join(harnessRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--extension",
          join(harnessRoot, ".pi/extensions/cowork.ts"),
          "--append-system-prompt",
          join(harnessRoot, ".pi/prompts/cowork-main.md"),
          "--provider",
          "cowork-glm",
          "--model",
          model,
          "--thinking",
          "off",
          "--print",
          "--mode",
          "json",
          "--session-dir",
          join(root, "sessions"),
          "--no-skills",
          "Delegate both synthetic tasks in parallel"
        ],
        {
          cwd: project,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...cleanEnv,
            COWORK_CONFIG: join(root, "config.json"),
            COWORK_API_BASE: `http://127.0.0.1:${provider.address().port}`,
            COWORK_API_KEY: "localhost-fixture",
            COWORK_MODEL: model,
            COWORK_WORKSPACE: root,
            COWORK_PROJECT_DIR: project,
            COWORK_HARNESS_ROOT: join(root, "empty-harness"),
            COWORK_TASK_ID: taskId,
            COWORK_RUN_ID: runId,
            COWORK_MAIN_MAX_TURNS: "4",
            COWORK_MAIN_MAX_TOKENS: "1024",
            COWORK_MAIN_TIMEOUT_MS: "10000",
            COWORK_MAX_TURNS: "3",
            COWORK_MAX_TOKENS: "1024",
            COWORK_MAX_ATTEMPTS: "1",
            COWORK_SUBAGENT_TIMEOUT_MS: "10000",
            COWORK_SUPPORTS_REASONING_EFFORT: "0",
            COWORK_SUPPORTS_IMAGES: "0",
            COWORK_WEB_TOOLS: "0",
            COWORK_SERPER_API_KEY: "",
            SERPER_API_KEY: "",
            COWORK_DISABLE_MAIN_GUARDIAN: "1",
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            NODE_OPTIONS: `--import ${preload}`
          }
        }
      );
      const output = [],
        errors = [];
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => errors.push(chunk));
      t.after(async () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* the isolated group exited */
        }
        provider.closeAllConnections();
        await new Promise((done) => provider.close(done));
        await rm(root, { recursive: true, force: true });
      });
      const [exitCode] = await once(child, "close");
      const stderr = Buffer.concat(errors).toString();
      assert.equal(exitCode, 0, stderr.slice(-2000));
      assert.ok(!stderr.includes("extension ctx is stale"), stderr);
      assert.deepEqual(serverErrors, []);
      assert.ok(
        requests.main >= 2 && requests.main <= 3,
        "a failed callback may wake one new Main turn before shutdown"
      );
      assert.equal(requests.ALPHA, alphaFails ? 1 : 2);
      assert.equal(requests.BETA, 2);
      const events = Buffer.concat(output)
        .toString()
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      assert.ok(
        events.filter((event) => event.type === "agent_end").every((event) => event.willRetry === false)
      );
      assert.equal(events.filter((event) => event.type.includes("retry")).length, 0);
      const queuePath = join(root, taskId, "runs", runId, "queue.json");
      const queue = JSON.parse(await readFile(queuePath, "utf8"));
      assert.deepEqual(
        queue.map((item) => item.status).sort(),
        alphaFails ? ["completed", "failed"] : ["completed", "completed"]
      );
      assert.ok(queue.every((item) => item.attempts === 1));
      const inboxPath = join(root, taskId, "runs", runId, "agents", "main", "inbox-store.json");
      const before = JSON.parse(await readFile(inboxPath, "utf8"));
      assert.deepEqual(
        before.map((message) => message.payload.status).sort(),
        alphaFails ? ["failed", "succeeded"] : ["succeeded", "succeeded"]
      );
      assert.equal(before.find((message) => message.payload.status === "succeeded").state, "ready");
      const settledTask = await store.readTask(taskId);
      assert.equal(settledTask.status, "waiting");
      assert.equal(settledTask.completion.signal, "interrupted");
      const succeeded = queue.find(
        (item) => item.status === "completed" && item.payload.task.includes("[BETA]")
      );
      const result = JSON.parse(
        await readFile(
          join(root, taskId, "runs", runId, "agents", "subagents", succeeded.agentId, "result.json"),
          "utf8"
        )
      );
      const checked = result.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "run_tests"
      );
      assert.equal(checked.details.exitCode, 0);
      assert.match(checked.details.stdout, /BETA_RESULT=42\nBETA_ASSERTIONS=passed/);
      // A fresh Main can recover the durable result without repeating the child.
      const inbox = new MainInboxDelivery(root, taskId, runId),
        delivered = [];
      await inbox.deliver((message) => delivered.push(message));
      assert.ok(
        delivered.some(
          (message) => message.details.status === "succeeded" && message.content.includes("BETA_RESULT=42")
        )
      );
      await inbox.acknowledge(delivered.map((message) => ({ ...message, role: "custom" })));
      const after = JSON.parse(await readFile(inboxPath, "utf8"));
      assert.ok(after.every((message) => message.state === "consumed"));
      assert.equal(
        (await store.readTask(taskId)).status,
        "waiting",
        "queueing without a real agent_start does not reopen the stopped Main"
      );
    }
  );
}
