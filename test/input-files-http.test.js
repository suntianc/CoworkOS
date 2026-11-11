import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";

test(
  "real HTTP upload, preview, task run and agent reading share the same original",
  { timeout: 30000 },
  async (t) => {
    const failures = [];
    let id,
      requests = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req.setEncoding("utf8")) raw += chunk;
      const request = JSON.parse(raw);
      const step = ++requests;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `upload-${step}`, object: "chat.completion.chunk", created: 1, model: "http-upload", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      try {
        if (step === 1) {
          assert.match(JSON.stringify(request.messages), new RegExp(id));
          send({
            tool_calls: [
              {
                index: 0,
                id: "read-input",
                type: "function",
                function: { name: "read_attachment", arguments: JSON.stringify({ id }) }
              }
            ]
          });
          send({}, "tool_calls");
        } else {
          assert.equal(step, 2);
          assert.match(
            JSON.stringify(request.messages.findLast((message) => message.role === "tool")),
            /原文件完整内容 😀/
          );
          send({ content: "已读完附件。" });
          send({}, "stop");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "fixture failed" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const dashboard = await startDashboard({
      modelEndpoint: `http://127.0.0.1:${server.address().port}/v1`,
      model: "http-upload"
    });
    t.after(async () => {
      await dashboard.stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const original = Buffer.from("原文件完整内容 😀");
    const upload = await fetch(`${dashboard.base}/api/uploads?name=${encodeURIComponent("材料.txt")}`, {
      method: "POST",
      body: original,
      headers: { "content-type": "application/octet-stream" }
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    id = file.uploadId;
    const download = await fetch(`${dashboard.base}/api/uploads/${id}`);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    const preview = await (await fetch(`${dashboard.base}/api/uploads/${id}/preview`)).json();
    assert.equal(preview.text, original.toString());
    assert.equal(preview.absolutePath, undefined);
    const post = (path, body) =>
      fetch(dashboard.base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    assert.equal((await post("/api/tasks", { taskId: "file-http", goal: "读附件" })).status, 201);
    const run = await post("/api/tasks/file-http/run", { prompt: "请看材料", attachmentIds: [id] });
    assert.equal(run.status, 202, await run.text());
    let detail;
    for (let count = 0; count < 150; count++) {
      detail = await (await fetch(`${dashboard.base}/api/tasks/file-http`)).json();
      if (!detail.runtime?.active && detail.messages?.some((message) => message.role === "assistant")) break;
      await delay(50);
    }
    assert.deepEqual(failures, []);
    assert.equal(requests, 2);
    assert.deepEqual(
      await readFile(join(dashboard.workspaceRoot, "file-http", "inputs", id, file.relativePath)),
      original
    );
    assert.equal(detail.artifacts.length, 0);
    assert.match(JSON.stringify(detail.messages), /atria_uploaded_files/);
    assert.equal(
      (await post("/api/tasks/file-http/run", { prompt: "坏附件", attachmentIds: ["missing"] })).status,
      400
    );
  }
);
