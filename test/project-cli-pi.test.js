import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";

test(
  "real CLI Pi inherits a project's edited folder and holds it until process exit",
  { timeout: 40_000 },
  async (t) => {
    let child;
    let releaseResponse;
    const model = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      const body = JSON.parse(raw);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "project-cli", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      if (!body.messages.some((message) => message.role === "tool")) {
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-project",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "project-marker.txt" }) }
            }
          ]
        });
        send({}, "tool_calls");
      } else {
        assert.ok(
          body.messages.some(
            (message) =>
              message.role === "tool" && JSON.stringify(message.content).includes("NEW_PROJECT_MARKER")
          ),
          "relative read must use the catalog's committed project folder"
        );
        await new Promise((done) => {
          releaseResponse = done;
        });
        send({ role: "assistant", content: "Read the selected project's file." });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
    const dashboard = await startDashboard({ modelEndpoint: endpoint, defaultProject: false });
    t.after(async () => {
      releaseResponse?.();
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        force.unref();
        await closed;
        clearTimeout(force);
      }
      await dashboard.stop();
      model.closeAllConnections();
      await new Promise((done) => model.close(done));
    });
    const oldFolder = join(dashboard.root, "old"),
      newFolder = join(dashboard.root, "new");
    await Promise.all([mkdir(oldFolder), mkdir(newFolder)]);
    await writeFile(join(oldFolder, "project-marker.txt"), "OLD_PROJECT_MARKER");
    await writeFile(join(newFolder, "project-marker.txt"), "NEW_PROJECT_MARKER");
    const api = (path, method, body) =>
      fetch(`${dashboard.base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    const created = await api("/api/projects", "POST", {
      projectName: "CLI project",
      projectDirectory: oldFolder
    });
    assert.equal(created.status, 201);
    const { project } = await created.json();
    const route = `/api/projects/${encodeURIComponent(project.projectId)}`;
    assert.equal(
      (
        await api("/api/tasks", "POST", {
          taskId: "cli-project",
          goal: "Read the selected folder",
          projectId: project.projectId
        })
      ).status,
      201
    );
    assert.equal((await api(route, "PATCH", { projectDirectory: newFolder })).status, 200);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
    );
    Object.assign(env, {
      ATRIA_HOME: join(dashboard.root, "home"),
      COWORK_HARNESS_ROOT: resolve("."),
      COWORK_WORKSPACE: dashboard.workspaceRoot,
      COWORK_GLOBAL_INDEX: join(dashboard.root, "global.json"),
      COWORK_CONFIG: join(dashboard.root, "config.json"),
      COWORK_PROJECT_DIR: oldFolder,
      COWORK_TASK_ID: "cli-project",
      COWORK_API_BASE: endpoint,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "fixture",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      PI_CODING_AGENT_DIR: join(dashboard.root, "cli-pi"),
      PI_OFFLINE: "1"
    });
    child = spawn(
      process.execPath,
      ["scripts/start-pi.mjs", "--mode", "json", "--print", "--no-session", "Read project-marker.txt."],
      { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const closed = once(child, "close");
    for (let attempt = 0; !releaseResponse && attempt < 400; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      await delay(50);
    }
    assert.ok(releaseResponse, output);
    assert.equal((await api(route, "PATCH", { projectDirectory: oldFolder })).status, 409);
    assert.equal((await api(route, "PATCH", { projectName: "Renamed during CLI run" })).status, 200);
    releaseResponse();
    const [code] = await closed;
    assert.equal(code, 0, output);
    assert.equal(
      (await api(route, "PATCH", { projectDirectory: oldFolder })).status,
      200,
      "finished CLI releases the project folder"
    );
  }
);
