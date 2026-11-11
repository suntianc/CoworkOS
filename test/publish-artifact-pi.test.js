import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { listTaskArtifacts, resolveTaskArtifact } from "../dist/src/workspace/artifact-store.js";

test(
  "real Main publishes an external PPT to the canonical task directory and fails honestly for missing files",
  { timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-publish-"));
    const project = join(root, "project"),
      workspace = join(root, "workspace");
    await mkdir(project);
    const name = "演示文稿.pptx";
    const candidate = join(project, name);
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]);
    await writeFile(candidate, bytes);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("publish-task", { goal: "发布成品 PPT" });
    await store.createRun("publish-task", "publish-run");
    let requests = 0,
      child,
      output = "";
    const failures = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req.setEncoding("utf8")) raw += chunk;
      const request = JSON.parse(raw);
      const step = ++requests;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `office-${step}`, object: "chat.completion.chunk", created: 1, model: "office-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      const call = (name, args) => {
        send({
          tool_calls: [
            {
              index: 0,
              id: `office-call-${step}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        });
        send({}, "tool_calls");
      };
      send({ role: "assistant" });
      try {
        if (step === 1) {
          assert.ok(request.tools.some((tool) => tool.function.name === "enable_tools"));
          assert.ok(!request.tools.some((tool) => tool.function.name === "publish_artifact"));
          call("enable_tools", { groups: ["delivery"] });
        } else if (step === 2) {
          assert.ok(request.tools.some((tool) => tool.function.name === "publish_artifact"));
          call("publish_artifact", { sourcePath: "missing.pptx" });
        } else if (step === 3) {
          const result = request.messages.findLast((message) => message.role === "tool");
          assert.match(JSON.stringify(result.content), /ENOENT|no such file/i);
          assert.deepEqual(await listTaskArtifacts({ workspaceRoot: workspace, taskId: "publish-task" }), []);
          call("publish_artifact", { sourcePath: name });
        } else {
          assert.equal(step, 4);
          const result = request.messages.findLast((message) => message.role === "tool");
          const text =
            typeof result.content === "string"
              ? result.content
              : result.content.map((part) => part.text || "").join("");
          const published = JSON.parse(text);
          assert.equal(published.absolutePath, join(workspace, "publish-task", "artifacts", name));
          assert.equal(
            published.mimeType,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          );
          assert.deepEqual(await readFile(published.absolutePath), bytes);
          const listed = await listTaskArtifacts({ workspaceRoot: workspace, taskId: "publish-task" });
          assert.equal(listed.length, 1);
          assert.equal(listed[0].artifactId, published.artifactId);
          const download = await resolveTaskArtifact({
            workspaceRoot: workspace,
            taskId: "publish-task",
            relativePath: name
          });
          assert.deepEqual(await readFile(download.absolutePath), bytes);
          send({ content: `成品已发布：[演示文稿](${published.absolutePath})` });
          send({}, "stop");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "Local Office integration failed." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        "publish-run",
        "--session-dir",
        join(root, "sessions"),
        "发布已经生成的成品 PPT。"
      ],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: "publish-task",
          COWORK_RUN_ID: "publish-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "office-fixture",
          COWORK_DASHBOARD_URL: "",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    const record = (chunk) => {
      output = (output + chunk).slice(-10000);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.equal(requests, 4, output);
  }
);
