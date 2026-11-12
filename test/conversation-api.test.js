import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildConversationExchanges } from "../web/assets/conversation.js";
import { buildLiveActivity } from "../web/assets/activity.js";

test(
  "Dashboard migrates legacy session CWD and retains follow-ups, reasoning, tools, final answers and title",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atria-conversation-api-"));
    const workspaceRoot = join(root, "workspace");
    const requests = [];
    let child;
    let output = "";
    const model = createServer(async (request, response) => {
      // The run reads the model list for its limits (#27); this fixture has none.
      if (request.method !== "POST") return void response.writeHead(404).end();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `completion-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "glm-5.3", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({
        role: "assistant",
        reasoning_content:
          requests.length === 1 ? "Inspect the fixture." : `Reasoning for answer ${requests.length - 1}.`
      });
      if (requests.length === 1) {
        send({
          tool_calls: [
            {
              index: 0,
              id: "read-fixture",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) }
            }
          ]
        });
        send({}, "tool_calls");
      } else {
        send({ content: requests.length === 2 ? "First request complete." : "Second request complete." });
        send({}, "stop");
      }
      response.write(
        `data: ${JSON.stringify({ id: `completion-${requests.length}`, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });
    try {
      await writeFile(join(root, "config.json"), "{}");
      await mkdir(workspaceRoot);
      await writeFile(join(workspaceRoot, "fixture.txt"), "selected project evidence");
      model.listen(0, "127.0.0.1");
      await once(model, "listening");
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port;
      await new Promise((done) => probe.close(done));
      const base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          COWORK_WORKSPACE: workspaceRoot,
          COWORK_GLOBAL_INDEX: join(root, "global.json"),
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_UI_PORT: String(port),
          COWORK_API_BASE: `http://127.0.0.1:${model.address().port}`,
          COWORK_API_KEY: "test-key",
          COWORK_MODEL: "glm-5.3",
          COWORK_REASONING_EFFORT: "high",
          COWORK_SUPPORTS_REASONING_EFFORT: "true",
          PI_CODING_AGENT_DIR: join(root, "pi-agent"),
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_SERPER_API_KEY: "",
          SERPER_API_KEY: "",
          COWORK_WEB_TOOLS: "0"
        }
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const get = async (path) => {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const post = async (path, body) => {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const value = await response.json();
        assert.ok(response.ok, JSON.stringify(value));
        return value;
      };
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          if ((await fetch(`${base}/api/tasks`)).ok) break;
        } catch {
          /* wait for listener */
        }
        if (child.exitCode !== null) throw new Error(`Dashboard exited: ${output}`);
        await delay(20);
      }
      const prompt = "Read the fixture and complete the first request.";
      await post("/api/tasks", { taskId: "conversation", goal: prompt });
      const run = await post("/api/tasks/conversation/run", { prompt });
      const waitForCompletion = async () => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const detail = await get("/api/tasks/conversation");
          if (!detail.runtime.active) {
            assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
            return detail;
          }
          await delay(30);
        }
        throw new Error(`Run did not finish: ${output}`);
      };
      let detail = await waitForCompletion();
      assert.equal(requests.length, 2);
      assert.ok(
        requests.every((request) => request.reasoning_effort === "high"),
        "Main must send high on the initial request and after a tool call"
      );
      assert.equal(detail.statistics.usage.totalTokens, 250);
      assert.equal(detail.statistics.usage.cacheRead, 40);
      assert.equal(detail.statistics.usage.responses, 2);
      assert.equal(detail.statistics.active, false);
      assert.ok(
        requests[1].messages.some(
          (message) =>
            message.role === "tool" && JSON.stringify(message.content).includes("selected project evidence")
        ),
        "relative read must use the user-selected project directory"
      );
      const system = requests[0].messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      assert.ok(system.includes(`用户选择的项目目录：${workspaceRoot}`));
      assert.ok(system.includes(join(workspaceRoot, "conversation", "agents", "main", "work")));
      assert.ok(system.includes(join(workspaceRoot, "conversation", "artifacts")));
      assert.ok(
        system.includes("virtual-agent-authoring"),
        "bundled skills remain available outside the harness directory"
      );
      assert.equal(detail.messages.at(-1).content.at(-1).text, "First request complete.");
      const firstEvents = detail.runtimeEvents.map((event) => event.eventId);
      // Older Dashboard runs recorded the harness CWD even for another project.
      const sessionDirectory = join(workspaceRoot, "conversation", "sessions", "main", "pi");
      const originalSession = (await readdir(sessionDirectory)).find((path) => path.endsWith(".jsonl"));
      const originalPath = join(sessionDirectory, originalSession);
      const legacyLines = (await readFile(originalPath, "utf8")).trimEnd().split("\n");
      legacyLines[0] = JSON.stringify({ ...JSON.parse(legacyLines[0]), cwd: resolve(".") });
      const legacySource = `${legacyLines.join("\n")}\n`;
      await writeFile(originalPath, legacySource);
      const next = await post("/api/tasks/conversation/run", {
        prompt: "Continue with the second request.",
        resume: false
      });
      assert.notEqual(next.runId, run.runId);
      detail = await waitForCompletion();
      assert.equal(
        requests.length,
        3,
        "the second request should reuse the existing session without repeating the tool call"
      );
      assert.equal(
        requests[2].reasoning_effort,
        "high",
        "restoring a conversation must preserve the configured reasoning effort"
      );
      assert.equal(detail.statistics.runId, next.runId);
      assert.equal(detail.statistics.scope, "conversation");
      assert.equal(detail.statistics.runCount, 2);
      assert.equal(
        detail.statistics.usage.totalTokens,
        375,
        "the conversation overview accumulates both requests"
      );
      assert.equal(detail.statistics.usage.responses, 3);
      assert.ok(
        requests[2].messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(prompt)
        ),
        "the model must receive the original user message"
      );
      assert.ok(
        requests[2].messages.some(
          (message) =>
            message.role === "assistant" &&
            JSON.stringify(message.content).includes("First request complete.")
        ),
        "the model must receive its previous final answer"
      );
      assert.equal(detail.task.goal, prompt);
      assert.equal(
        (await get("/api/tasks")).tasks.find((task) => task.taskId === "conversation").goal,
        prompt
      );
      assert.equal(detail.messages.filter((message) => message.role === "user").length, 2);
      assert.ok(firstEvents.every((id) => detail.runtimeEvents.some((event) => event.eventId === id)));
      const exchanges = buildConversationExchanges(detail.messages, detail.runtimeEvents);
      assert.equal(exchanges.length, 2);
      const first = buildLiveActivity(exchanges[0].events);
      const second = buildLiveActivity(exchanges[1].events);
      assert.equal(first[0].reasoning, "Inspect the fixture.");
      assert.equal(first[0].calls[0].name, "read");
      assert.equal(first[0].calls[0].statusLabel, "调用完成");
      assert.equal(first.at(-1).answer, "First request complete.");
      assert.equal(second[0].reasoning, "Reasoning for answer 2.");
      assert.equal(second[0].answer, "Second request complete.");
      assert.deepEqual(
        (await get("/api/tasks/conversation")).messages,
        detail.messages,
        "reload must preserve conversation history"
      );
      const reloaded = (await get("/api/tasks/conversation")).statistics;
      assert.deepEqual(reloaded.usage, detail.statistics.usage);
      assert.equal(reloaded.elapsedMs, detail.statistics.elapsedMs);
      const sessions = await readdir(sessionDirectory);
      assert.equal(
        sessions.filter((path) => path.endsWith(".jsonl")).length,
        2,
        "the legacy session is copied into the selected CWD once"
      );
      assert.equal(
        await readFile(originalPath, "utf8"),
        legacySource,
        "migration must preserve the source session"
      );
      const saved = JSON.parse(
        await readFile(
          join(workspaceRoot, "conversation", "agents", "main", "context", "messages.json"),
          "utf8"
        )
      );
      assert.equal(
        saved.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
        2
      );
      assert.ok(
        saved.some(
          (entry) =>
            entry.message?.role === "assistant" &&
            JSON.stringify(entry.message.content).includes("Second request complete.")
        ),
        "the final reply must be saved at settlement"
      );
      await post("/api/tasks/conversation/run", { prompt: "Continue in the same project again." });
      detail = await waitForCompletion();
      assert.equal(requests.length, 4);
      assert.equal(requests[3].reasoning_effort, "high");
      assert.equal(detail.statistics.usage.totalTokens, 500);
      assert.equal(detail.statistics.runCount, 3);
      assert.equal(requests[3].messages.filter((message) => message.role === "user").length, 3);
      assert.equal(
        (await readdir(sessionDirectory)).filter((path) => path.endsWith(".jsonl")).length,
        2,
        "aligned sessions must continue without another copy"
      );
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      model.closeAllConnections();
      await new Promise((done) => model.close(done));
      await rm(root, { recursive: true, force: true });
    }
  }
);
