import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

// Exercise the actual Pi launch/catalog/read seam against a local provider.
// The provider scripts the read: this verifies integration, not LLM routing
// quality or an improvement in predictive performance.
test(
  "real Pi discovers the renamed ML skill and reads its body only on demand",
  { timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-ml-skill-pi-"));
    const workspace = join(root, "workspace"),
      project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("ml-skill-task", { goal: "训练分类器并导出预测" });
    await store.createRun("ml-skill-task", "ml-skill-run");
    const name = "machine-learning-model-search";
    const path = resolve(".pi/skills", name, "SKILL.md");
    const failures = [];
    let requests = 0,
      child,
      output = "";
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.end('{"data":[]}');
        return;
      }
      let raw = "";
      for await (const chunk of req.setEncoding("utf8")) raw += chunk;
      const request = JSON.parse(raw);
      const step = ++requests;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "ml-skill", object: "chat.completion.chunk", created: 1, model: "ml-skill-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      try {
        const context = JSON.stringify(request.messages);
        const names = request.tools.map((tool) => tool.function.name);
        assert.ok(context.includes(name), "the renamed skill is discoverable in real Main context");
        assert.ok(
          !context.includes("mlebench-search"),
          "the old skill must not remain as a second catalog entry"
        );
        assert.ok(
          !names.includes("cad_run_program"),
          "ML integration must not activate an unrelated application"
        );
        if (step === 1) {
          assert.ok(context.includes(path));
          assert.ok(
            !context.includes("Independent routes with a complete problem view"),
            "the body is not loaded eagerly"
          );
          send({
            tool_calls: [
              {
                index: 0,
                id: "read-ml-skill",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path }) }
              }
            ]
          });
          send({}, "tool_calls");
        } else {
          assert.equal(step, 2);
          const result = request.messages.findLast((message) => message.role === "tool");
          assert.ok(result, "the real read tool supplied a result");
          const body = JSON.stringify(result.content);
          assert.ok(body.includes("Independent routes with a complete problem view"));
          assert.ok(body.includes("start_job"));
          assert.ok(body.includes("narrow bug fixes"));
          assert.ok(body.includes("CAD and Blender modeling"));
          send({ content: "已读取机器学习搜索流程。" });
          send({}, "stop");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "Skill integration failed." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid && child.exitCode === null) {
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
        "ml-skill-run",
        "--session-dir",
        join(root, "sessions"),
        "请从提供的数据训练一个分类器并导出预测，先读取适用的工作流。"
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
          COWORK_TASK_ID: "ml-skill-task",
          COWORK_RUN_ID: "ml-skill-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "ml-skill-fixture",
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
    child.stderr.on("data", record);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.equal(requests, 2);
  }
);
