import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

// A real Pi session against a local model-protocol fixture. Unlike the fake
// extension API, this checks the provider-visible tools after a mid-turn bind.
test(
  "real Pi discovers built-in applications, creates text and immediately exposes its tools",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-text-bootstrap-"));
    const workspace = join(root, "workspace"),
      project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("bootstrap-task", { goal: "从对话创建文本" });
    await store.createRun("bootstrap-task", "bootstrap-run");
    const failures = [],
      calls = [];
    const executionEnds = [];
    let requestCount = 0,
      child,
      output = "";
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      requestCount += 1;
      const step = requestCount - 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "bootstrap", object: "chat.completion.chunk", created: 1, model: "bootstrap-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      try {
        const names = request.tools.map((tool) => tool.function.name);
        let name, args;
        if (requestCount === 1) {
          assert.ok(names.includes("enable_tools"));
          assert.ok(!names.includes("create_resource"));
          assert.ok(names.includes("call_subagent"));
          name = "enable_tools";
          args = { groups: ["applications"] };
        } else if (step === 1) {
          assert.ok(names.includes("list_applications"));
          name = "list_applications";
          args = {};
        } else if (step === 2) {
          const catalog = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
          assert.deepEqual(
            catalog.applications.map((application) => application.appType),
            ["text-editor"]
          );
          assert.ok(!names.includes("read_document"));
          const schema = request.tools.find((tool) => tool.function.name === "create_resource").function
            .parameters;
          assert.ok(schema.properties.initialContent.anyOf.some((branch) => branch.type === "object"));
          name = "create_resource";
          args = {
            kind: "text/markdown",
            title: "对话笔记.md",
            initialContent: "Original"
          };
        } else {
          const result = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
          assert.notEqual(result.ok, false);
          assert.ok(!result.error, JSON.stringify(result));
          assert.ok(names.includes("read_document"));
          assert.ok(names.includes("write_document"));
          if (step === 3) {
            assert.equal(result.bound, true);
            assert.deepEqual(result.nextAction, { tool: "read_document", arguments: {} });
            name = "read_document";
            args = {};
          } else if (step === 4) {
            assert.equal(result.result.content, "Original");
            name = "write_document";
            args = { content: "Updated document" };
          } else if (step === 5) {
            name = "read_document";
            args = {};
          } else {
            assert.equal(step, 6);
            assert.equal(result.result.content, "Updated document");
            send({ content: "已创建并读回核对文档。" });
            send({}, "stop");
          }
        }

        if (name) {
          calls.push(name);
          send({
            tool_calls: [
              {
                index: 0,
                id: `bootstrap-${requestCount}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          });
          send({}, "tool_calls");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "接入回归失败。" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
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
        "bootstrap-run",
        "--session-dir",
        join(root, "sessions"),
        "帮我画一个火箭CAD吧"
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
          COWORK_TASK_ID: "bootstrap-task",
          COWORK_RUN_ID: "bootstrap-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "bootstrap-fixture",
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
      output = (output + chunk).slice(-10_000);
    };
    child.stdout.on("data", record);
    let pendingLine = "";
    child.stdout.on("data", (chunk) => {
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "tool_execution_end") executionEnds.push(event);
        } catch {
          /* startup diagnostics are not JSON events */
        }
      }
    });
    child.stderr.on("data", record);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.deepEqual(calls, [
      "enable_tools",
      "list_applications",
      "create_resource",
      "read_document",
      "write_document",
      "read_document"
    ]);
    const edits = executionEnds.filter((event) => event.toolName === "write_document");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].isError, false);
    const service = new ApplicationService(workspace);
    const resources = await service.listResources("bootstrap-task");
    assert.equal(resources.length, 1);
    const saved = await service.readResource("bootstrap-task", resources[0].resourceId);
    assert.equal(saved.resource.revision, 1);
    assert.equal(saved.snapshot.content, "Updated document");
  }
);
