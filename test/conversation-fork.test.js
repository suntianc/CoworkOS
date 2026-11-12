import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

test(
  "Fork copies a conversation's history up to one reply into a settled conversation in the same project",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "formicand-conversation-fork-"));
    const workspaceRoot = join(root, "workspace");
    const projectDirectory = join(root, "project");
    const requests = [];
    let child;
    let output = "";
    const model = createServer(async (request, response) => {
      // The run reads the model list for its limits (#27); this fixture has none.
      if (request.method !== "POST") return void response.writeHead(404).end();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `completion-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "glm-5.3", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant", content: `Answer ${requests.length}.` });
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    try {
      await writeFile(join(root, "config.json"), "{}");
      await mkdir(workspaceRoot);
      await mkdir(projectDirectory);
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
          PI_CODING_AGENT_DIR: join(root, "pi-agent"),
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_SERPER_API_KEY: "",
          SERPER_API_KEY: "",
          COWORK_WEB_TOOLS: "0"
        }
      });
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const request = async (method, path, body) => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined
        });
        return { status: response.status, body: await response.json() };
      };
      const get = async (path) => {
        const { status, body } = await request("GET", path);
        assert.equal(status, 200, JSON.stringify(body));
        return body;
      };
      const post = async (path, body) => {
        const result = await request("POST", path, body);
        assert.ok(result.status < 300, JSON.stringify(result.body));
        return result.body;
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
      const settled = async (taskId) => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const detail = await get(`/api/tasks/${taskId}`);
          if (!detail.runtime.active && detail.task.status === "completed") return detail;
          await delay(30);
        }
        throw new Error(`Run did not finish: ${output}`);
      };
      const { project } = await post("/api/projects", { projectName: "Fork", projectDirectory });
      await post("/api/tasks", { taskId: "source", goal: "First question.", projectId: project.projectId });
      await post("/api/tasks/source/run", { prompt: "First question." });
      await settled("source");
      await post("/api/tasks/source/run", { prompt: "Second question." });
      const source = await settled("source");
      const replies = source.messages.filter((message) => message.role === "assistant");
      assert.deepEqual(
        replies.map((message) => message.content.at(-1).text),
        ["Answer 1.", "Answer 2."]
      );

      const missing = await request("POST", "/api/tasks/source/fork", {
        messageId: "not-a-reply",
        taskId: "missing-fork"
      });
      assert.equal(missing.status, 404, JSON.stringify(missing.body));
      assert.ok(
        (await request("GET", "/api/tasks/missing-fork")).status >= 400,
        "a failed fork leaves no conversation"
      );

      const forked = await post("/api/tasks/source/fork", {
        messageId: replies[0].id,
        taskId: "forked",
        title: "Fork of the first answer"
      });
      assert.equal(forked.taskId, "forked");
      assert.equal(forked.projectId, project.projectId);
      const detail = await get("/api/tasks/forked");
      assert.equal(detail.task.status, "completed");
      assert.equal(detail.task.title, "Fork of the first answer");
      assert.equal(detail.runtime.active, false);
      assert.deepEqual(
        detail.messages
          .map((message) => [message.role, text(message)].join(":"))
          .map((line) => line.slice(0, 40)),
        source.messages.slice(0, 2).map((message) => [message.role, text(message)].join(":").slice(0, 40))
      );
      assert.equal((await get("/api/tasks/source")).messages.length, source.messages.length);

      // The next message in the fork continues from the first answer only.
      await post("/api/tasks/forked/run", { prompt: "Third question." });
      await settled("forked");
      const context = requests.at(-1).messages.map(text).join("\n");
      assert.ok(context.includes("First question."), context);
      assert.ok(context.includes("Answer 1."), context);
      assert.ok(context.includes("Third question."), context);
      assert.ok(!context.includes("Second question."), context);
      assert.ok(!context.includes("Answer 2."), context);
    } finally {
      child?.kill();
      if (child?.exitCode === null) await once(child, "exit");
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
