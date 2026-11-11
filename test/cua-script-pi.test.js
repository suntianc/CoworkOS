import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";
import { createImageArchive } from "../dist/src/tools/image-archive.js";

test(
  "real Pi loads CUA skill and runs persistent JavaScript cells through native HTTP with cancellation",
  { timeout: 80_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atria-cua-script-pi-")),
      previous = { ...process.env };
    const requests = [],
      effects = [],
      started = [];
    const target = {
      pid: 11,
      windowId: 12,
      bundleId: "org.atria.fixture",
      application: "Isolated fixture",
      title: "Script protocol"
    };
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const steps = [
      { name: "load_skill", params: { name: "cua" } },
      { name: "enable_tools", params: { groups: ["computer", "cua"] } },
      {
        name: "cua_script",
        params: {
          code: "const found=await cua.computer.discover(); state.win=await cua.computer.select({pid:found.windows[0].pid,windowId:found.windows[0].windowId,mode:'control'}); await state.win.act({type:'activate'}); await state.win.act({type:'type',text:'fixture input'}); state.n=1; return {sessionId:state.win.sessionId,observation:state.win.observation};"
        }
      },
      {
        name: "cua_script",
        params: {
          code: "state.n++; await state.win.wait({type:'accessibility_text',text:'Ready',state:'present'},{timeoutMs:500}); await state.win.act({type:'key',keys:['Enter']}); await cua.emitImage(state.win.observation.imageRef); return {n:state.n,sessionId:state.win.sessionId,observation:state.win.observation};"
        }
      },
      {
        name: "cua_script",
        params: {
          code: "await state.win.act({type:'type',text:'late input'}); await state.win.act({type:'type',text:'never input'});",
          timeoutMs: 100
        }
      },
      {
        name: "cua_script",
        params: {
          code: "const reset=typeof state.win==='undefined'; const current=await cua.computer.status(); state.win=cua.computer.use(current.session.sessionId); await state.win.act({type:'activate'}); return {reset,sessionId:state.win.sessionId,observation:state.win.observation};"
        }
      }
    ];
    let dashboard;
    const model = createServer(async (request, response) => {
      if (request.url.endsWith("/models")) {
        response.end(JSON.stringify({ data: [{ id: "cua-script-fixture" }] }));
        return;
      }
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      const input = JSON.parse(raw),
        index = requests.length,
        step = steps[index];
      requests.push(input);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `script-${index}`, object: "chat.completion.chunk", created: 1, model: "cua-script-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      if (step) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `script-call-${index}`,
              type: "function",
              function: { name: step.name, arguments: JSON.stringify(step.params) }
            }
          ]
        });
        send({}, "tool_calls");
      } else {
        send({ content: "CUA_SCRIPT_PROTOCOL_DONE" });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    try {
      await mkdir(join(root, "workspace"));
      await writeFile(join(root, "config.json"), "{}");
      Object.assign(process.env, {
        COWORK_CONFIG: join(root, "config.json"),
        COWORK_WORKSPACE: join(root, "workspace"),
        COWORK_GLOBAL_INDEX: join(root, "global.json"),
        COWORK_TABS_INDEX: join(root, "tabs.json"),
        COWORK_API_BASE: `http://127.0.0.1:${model.address().port}/v1`,
        COWORK_API_KEY: "local-fixture",
        COWORK_MODEL: "cua-script-fixture",
        COWORK_SUPPORTS_IMAGES: "1",
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1"
      });
      delete process.env.COWORK_API_TOKEN;
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port,
        base = `http://127.0.0.1:${port}`;
      await new Promise((done) => probe.close(done));
      dashboard = createDashboardApplication({
        projectRoot: resolve("."),
        port,
        computerDriver: {
          status: async () => ({
            available: true,
            screenRecording: true,
            accessibility: true,
            windows: [target]
          }),
          observe: async () => ({
            width: 1,
            height: 1,
            image,
            frame: { x: 0, y: 0, width: 1, height: 1 },
            accessibilityText: "Ready",
            accessibility: { available: true, truncated: false, elements: [] }
          }),
          act: async (selected, action, _frame, signal) => {
            started.push(action);
            if (action.text === "late input") await delay(1000, undefined, { signal });
            signal.throwIfAborted();
            effects.push({ selected, action });
          }
        }
      });
      dashboard.server.listen(port, "127.0.0.1");
      await once(dashboard.server, "listening");
      const post = (path, body) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      assert.equal(
        (await post("/api/tasks", { taskId: "cua-script-agent", goal: "isolated scripting protocol" }))
          .status,
        201
      );
      await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "control" });
      assert.equal(
        (
          await post("/api/tasks/cua-script-agent/run", {
            prompt: "Load cua skill and execute the isolated script protocol."
          })
        ).status,
        202
      );
      let task;
      for (let index = 0; index < 600; index++) {
        task = (await (await fetch(`${base}/api/tasks/cua-script-agent`)).json()).task;
        if (
          ["completed", "failed"].includes(task.status) &&
          !dashboard.routePorts.activeRuns.has("cua-script-agent")
        )
          break;
        await delay(100);
      }
      assert.equal(task.status, "completed");
      assert.equal(requests.length, steps.length + 1);
      const payload = (index) =>
        JSON.parse(requests[index].messages.findLast((message) => message.role === "tool").content);
      const loaded = payload(1);
      assert.ok(
        JSON.stringify(loaded).includes("Script state and output"),
        "real Pi must resolve and load the bundled CUA skill"
      );
      const first = payload(3),
        second = payload(4),
        cancelled = payload(5),
        recovered = payload(6);
      assert.equal(first.value.sessionId, second.value.sessionId);
      assert.equal(second.value.n, 2);
      assert.equal(first.vmReset, false);
      assert.equal(first.dispatchStatus, "sent");
      assert.equal(cancelled.errorCode, "script_timeout");
      assert.equal(cancelled.dispatchStatus, "unknown");
      assert.equal(cancelled.vmReset, true);
      assert.equal(cancelled.requiresObservation, true);
      const detail = await (await fetch(`${base}/api/tasks/cua-script-agent`)).json();
      const failedTool = detail.runtimeEvents.find(
        (event) =>
          event.payload.type === "tool_execution_end" &&
          event.payload.toolName === "cua_script" &&
          event.payload.result?.details?.errorCode === "script_timeout"
      );
      assert.ok(failedTool, "real Pi must persist the structured script failure");
      assert.equal(failedTool.payload.isError, true, "Pi must expose a failed tool result as an error");
      assert.equal(failedTool.payload.result.details.dispatchStatus, "unknown");
      assert.equal(recovered.value.reset, true);
      assert.equal(recovered.value.sessionId, first.value.sessionId);
      assert.ok(started.some((action) => action.text === "late input"));
      assert.deepEqual(
        effects.map((effect) => effect.action),
        [
          { type: "activate" },
          { type: "type", text: "fixture input" },
          { type: "key", keys: ["Enter"] },
          { type: "activate" }
        ]
      );
      assert.ok(effects.every((effect) => effect.selected.windowId === target.windowId));
      assert.equal(JSON.stringify(first.calls).includes("fixture input"), false);
      for (const value of [first.value, second.value, recovered.value]) {
        const stored = await createImageArchive({
          taskDirectory: join(root, "workspace", "cua-script-agent")
        }).read(value.observation.imageRef);
        assert.equal(stored.data.toString("base64"), image);
        assert.equal(stored.record.source.sourceObservationId, value.observation.observationId);
      }
      const images = requests[4].messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : []
      );
      assert.ok(
        images.some(
          (block) => block.type === "image_url" && block.image_url.url === `data:image/png;base64,${image}`
        )
      );
      assert.ok(requests[2].tools.some((tool) => tool.function.name === "cua_script"));
    } finally {
      await dashboard?.stop();
      model.closeAllConnections();
      await new Promise((done) => model.close(done));
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  }
);
