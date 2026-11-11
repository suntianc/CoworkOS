import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: edit then change project directory and verify actual tool CWD`,
    { timeout: 90_000 },
    async (t) => {
      const requests = [];
      let release;
      const gate = new Promise((done) => {
        release = done;
      });
      let marker;
      const provider = createServer(async (request, response) => {
        if (request.method === "GET") {
          response.end(JSON.stringify({ data: [{ id: "fixture" }] }));
          return;
        }
        let raw = "";
        for await (const chunk of request.setEncoding("utf8")) raw += chunk;
        const body = JSON.parse(raw);
        requests.push(body);
        const history = JSON.stringify(body.input ?? body.messages);
        const reply = (value) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(protocolStream(api, value));
        };
        if (history.includes("NEXT_PROJECT_TURN")) {
          if (
            !(body.input ?? body.messages).some(
              (message) => message.role === "tool" || message.type === "function_call_output"
            )
          )
            return reply({ name: "bash", arguments: { command: "pwd" } });
          return reply({ text: "新目录中的回复" });
        }
        if (history.includes("NEW_EDIT_REQUEST")) return reply({ text: "修改后的真实回复" });
        if (history.includes("OLD_EDIT_REQUEST")) {
          if (
            !(body.input ?? body.messages).some(
              (message) => message.role === "tool" || message.type === "function_call_output"
            )
          )
            return reply({
              name: "bash",
              arguments: { command: `printf 'once\\n' >> '${marker.replaceAll("'", "'\\''")}'` }
            });
          await gate;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "synthetic rejected old request" } }));
          return;
        }
        reply({ text: "前文真实回复" });
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const dashboard = await startDashboard();
      marker = join(dashboard.workspaceRoot, "edit-operation.txt");
      t.after(async () => {
        release();
        await dashboard.stop();
        provider.closeAllConnections();
        await new Promise((done) => provider.close(done));
      });
      const call = async (path, body, method = "POST") => {
        const response = await fetch(
          dashboard.base + path,
          body === undefined
            ? {}
            : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        );
        return { status: response.status, value: await response.json() };
      };
      const settle = async (taskId) => {
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          const { value } = await call(`/api/tasks/${taskId}`);
          if (!value.runtime.active) return value;
          await delay(30);
        }
        assert.fail("Main did not settle");
      };
      assert.equal(
        (
          await call("/api/model-settings", {
            baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
            api,
            apiKey: "local-fixture-key",
            model: "fixture"
          })
        ).status,
        200
      );
      const { value: task } = await call("/api/tasks", {
        taskId: "task-edit-pi",
        goal: "PERSIST_PREFIX",
        projectId: dashboard.projectId
      });
      const run = (prompt) =>
        call(`/api/tasks/${task.taskId}/run`, { prompt, composer: { text: prompt, attachments: [] } });
      assert.equal((await run("PERSIST_PREFIX")).status, 202);
      await settle(task.taskId);
      assert.equal((await run("OLD_EDIT_REQUEST")).status, 202);
      const until = Date.now() + 30_000;
      while (requests.length < 3 && Date.now() < until) await delay(25);
      assert.equal(requests.length, 3);
      const { value: active } = await call(`/api/tasks/${task.taskId}`);
      const edit = {
        ...active.editableMessage,
        body: "NEW_EDIT_REQUEST",
        attachmentIds: [],
        editId: randomUUID()
      };
      assert.equal((await call(`/api/tasks/${task.taskId}/messages/edit`, edit)).status, 409);
      release();
      const failed = await settle(task.taskId);
      assert.equal(failed.task.status, "failed");
      const failedRequest = await new MainRequestStore(
        mainRequestPath(dashboard.workspaceRoot, task.taskId),
        task.taskId
      ).pending();
      assert.match(failedRequest.body, /OLD_EDIT_REQUEST/);
      Object.assign(edit, failed.editableMessage);
      edit.body = "NEW_EDIT_REQUEST";
      const accepted = await call(`/api/tasks/${task.taskId}/messages/edit`, edit);
      assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
      const detail = await settle(task.taskId);
      assert.equal(detail.task.status, "completed");
      assert.equal(requests.length, 4);
      const newBody = JSON.stringify(requests.at(-1));
      assert.match(newBody, /PERSIST_PREFIX/);
      assert.match(newBody, /前文真实回复/);
      assert.match(newBody, /NEW_EDIT_REQUEST/);
      assert.doesNotMatch(newBody, /OLD_EDIT_REQUEST|once\\n|synthetic rejected/);
      assert.equal(await readFile(marker, "utf8"), "once\n");
      const nextProject = join(dashboard.root, "next-project");
      await mkdir(nextProject);
      assert.equal(
        (await call(`/api/projects/${dashboard.projectId}`, { projectDirectory: nextProject }, "PATCH"))
          .status,
        200
      );
      assert.equal((await run("NEXT_PROJECT_TURN")).status, 202);
      const moved = await settle(task.taskId);
      assert.equal(moved.task.status, "completed");
      assert.equal(requests.length, 6);
      assert.ok(
        JSON.stringify(requests.at(-1)).includes(JSON.stringify(await realpath(nextProject)).slice(1, -1)),
        JSON.stringify({
          expected: await realpath(nextProject),
          toolOutputs: (requests.at(-1).input ?? requests.at(-1).messages)
            .filter((message) => message.role === "tool" || message.type === "function_call_output")
            .map((message) => message.output ?? message.content)
        })
      );
      assert.equal(await readFile(marker, "utf8"), "once\n");
      await dashboard.restart({ newPort: true });
      const restored = (await call(`/api/tasks/${task.taskId}`)).value;
      assert.doesNotMatch(JSON.stringify(restored.messages), /OLD_EDIT_REQUEST/);
      assert.match(JSON.stringify(restored.messages), /NEW_EDIT_REQUEST/);
      assert.equal(
        await new MainRequestStore(
          mainRequestPath(dashboard.workspaceRoot, task.taskId),
          task.taskId
        ).pending(),
        undefined
      );
    }
  );
}
