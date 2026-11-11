import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InputStore, inputPrompt } from "../dist/src/workspace/input-store.js";
import { Readable } from "node:stream";

test(
  "real Main reads local upload text and returns an image to a vision-capable model",
  { timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-publish-"));
    const project = join(root, "project"),
      workspace = join(root, "workspace");
    await mkdir(project);
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("publish-task", { goal: "读取附件" });
    await store.createRun("publish-task", "publish-run");
    await writeFile(join(root, "config.json"), "{}");
    const uploads = new InputStore(join(root, "uploads"));
    const txt = await uploads.receive("材料.txt", Readable.from(["实际附件内容 😀"]));
    const imageBytes = await readFile("web/assets/atria-symbol.png");
    const img = await uploads.receive("截图.png", Readable.from([imageBytes]));
    await uploads.attach(workspace, "publish-task", [txt.uploadId, img.uploadId]);
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
          assert.ok(request.tools.some((tool) => tool.function.name === "read_attachment"));
          assert.match(JSON.stringify(request.messages), new RegExp(txt.uploadId));
          call("read_attachment", { id: txt.uploadId });
        } else if (step === 2) {
          assert.match(
            JSON.stringify(request.messages.findLast((message) => message.role === "tool")),
            /实际附件内容/
          );
          call("read_attachment", { id: img.uploadId });
        } else {
          assert.equal(step, 3);
          const serialized = JSON.stringify(request.messages);
          assert.match(serialized, /data:image\/png;base64/);
          assert.ok(serialized.includes(imageBytes.toString("base64")));
          send({ content: "已读取文本和图片附件。" });
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
        "读取材料和截图。" + inputPrompt(join(workspace, "publish-task"), [txt, img])
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
          COWORK_SUPPORTS_IMAGES: "1",
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
    assert.equal(requests, 3, output);
  }
);
