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

for (const globalPolicy of [false, true, "run-exit"])
  test(
    `${globalPolicy ? (globalPolicy === "run-exit" ? "global policy + new conversation + automatic release on Run exit: " : "global policy + selection + renewal + revocation: ") : ""}real Pi CUA loop delivers native images and consumes successive observations through HTTP (fixture driver)`,
    { timeout: 80_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atria-computer-agent-"));
      const previous = { ...process.env };
      const requests = [],
        effects = [];
      let grant,
        dashboard,
        actionIndex = 0,
        now = Date.now(),
        firstExpiresAt;
      const target = {
        pid: 11,
        windowId: 12,
        bundleId: "org.atria.fixture",
        application: "Isolated fixture",
        title: "Protocol test"
      };
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const steps = globalPolicy
        ? [
            "computer_status",
            "computer_discover",
            "computer_select",
            "computer_observe",
            "computer_wait",
            "computer_act",
            "computer_act",
            "computer_act",
            "computer_act",
            "computer_act",
            ...(globalPolicy === "run-exit" ? [] : ["computer_release", "computer_status"])
          ]
        : [
            "computer_status",
            "computer_observe",
            "computer_wait",
            "computer_act",
            "computer_act",
            "computer_act",
            "computer_act",
            "computer_act"
          ];
      const actions = [
        { type: "press", elementId: "button" },
        { type: "set_value", elementId: "field", value: "CoworkOS AX 中文 😀" },
        { type: "click", x: 0, y: 0, button: "left" },
        { type: "type", text: "CoworkOS 中文 😀" },
        { type: "key", keys: ["Meta", "a"] }
      ];
      const model = createServer(async (request, response) => {
        if (request.url.endsWith("/models")) {
          response.end(JSON.stringify({ data: [{ id: "computer-fixture" }] }));
          return;
        }
        let raw = "";
        for await (const chunk of request.setEncoding("utf8")) raw += chunk;
        const input = JSON.parse(raw);
        requests.push(input);
        const index = requests.length - 1,
          name = steps[index];
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (delta, finish_reason = null) =>
          response.write(
            `data: ${JSON.stringify({ id: `computer-${index}`, object: "chat.completion.chunk", created: 1, model: "computer-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          );
        send({ role: "assistant" });
        if (name) {
          const observed = input.messages.findLast((message) => message.role === "tool");
          const result = observed && JSON.parse(observed.content);
          if (result?.session?.sessionId) {
            grant = result.session;
            firstExpiresAt ??= grant.expiresAt;
          }
          if (globalPolicy && name === "computer_observe") now += 300_001;
          if (globalPolicy === true && name === "computer_status" && index > 0)
            await dashboard.computerHostRequest({ operation: "policy", enabled: false, mode: "control" });
          const params =
            name === "computer_discover"
              ? {}
              : name === "computer_select"
                ? { pid: target.pid, windowId: target.windowId, mode: "control" }
                : name === "computer_release"
                  ? { sessionId: grant.sessionId }
                  : name === "computer_status"
                    ? {}
                    : name === "computer_observe"
                      ? { sessionId: grant.sessionId }
                      : name === "computer_wait"
                        ? {
                            sessionId: grant.sessionId,
                            condition: { type: "element", name: "Save", state: "enabled" },
                            timeoutMs: 500
                          }
                        : {
                            sessionId: grant.sessionId,
                            observationId: result?.observation?.observationId || result?.observationId,
                            action: (() => {
                              const action = actions[actionIndex++];
                              return action.elementId
                                ? {
                                    ...action,
                                    elementId: (result?.observation || result).accessibility.elements.find(
                                      (element) =>
                                        element.name === (action.elementId === "button" ? "Save" : "Input")
                                    ).elementId
                                  }
                                : action;
                            })()
                          };
          send({
            tool_calls: [
              {
                index: 0,
                id: `computer-call-${index}`,
                type: "function",
                function: { name, arguments: JSON.stringify(params) }
              }
            ]
          });
          send({}, "tool_calls");
        } else {
          send({ content: "CUA_PROTOCOL_DONE" });
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
          COWORK_MODEL: "computer-fixture",
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
        const base = `http://127.0.0.1:${probe.address().port}`;
        await new Promise((done) => probe.close(done));
        dashboard = createDashboardApplication({
          projectRoot: resolve("."),
          port: Number(new URL(base).port),
          computerClock: () => now,
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
              accessibilityText: "Isolated fixture input",
              accessibility: {
                available: true,
                truncated: false,
                elements: [
                  {
                    elementId: "button",
                    role: "AXButton",
                    name: "Save",
                    enabled: true,
                    actions: ["press"],
                    path: [],
                    identity: "button-identity",
                    fingerprint: "button-state"
                  },
                  {
                    elementId: "field",
                    role: "AXTextField",
                    name: "Input",
                    value: "",
                    enabled: true,
                    actions: ["set_value"],
                    path: [0],
                    identity: "field-identity",
                    fingerprint: "field-state"
                  }
                ]
              }
            }),
            act: async (selected, action) => effects.push({ selected, action })
          }
        });
        dashboard.server.listen(Number(new URL(base).port), "127.0.0.1");
        await once(dashboard.server, "listening");
        const post = (path, body) =>
          fetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
        if (globalPolicy === "run-exit")
          await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "control" });
        assert.equal(
          (await post("/api/tasks", { taskId: "computer-agent", goal: "isolated CUA protocol" })).status,
          201
        );
        if (globalPolicy)
          await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "control" });
        else
          grant = await dashboard.computerHostRequest({
            operation: "authorize",
            taskId: "computer-agent",
            ...target,
            mode: "control"
          });
        assert.equal(
          (await post("/api/tasks/computer-agent/run", { prompt: "Perform the isolated CUA protocol." }))
            .status,
          202
        );
        let task;
        for (let index = 0; index < 600; index++) {
          task = (await (await fetch(`${base}/api/tasks/computer-agent`)).json()).task;
          if (
            (task.status === "completed" || task.status === "failed") &&
            !dashboard.routePorts.activeRuns.has("computer-agent")
          )
            break;
          await delay(100);
        }
        assert.equal(task.status, "completed");
        assert.equal(requests.length, steps.length + 1);
        const visibleTools = requests[0].tools.map((tool) => tool.function.name);
        for (const name of [
          "computer_status",
          "computer_observe",
          "computer_wait",
          "computer_act",
          ...(globalPolicy ? ["computer_discover", "computer_select", "computer_release"] : [])
        ])
          assert.ok(
            visibleTools.includes(name),
            `${name} must be available to an ordinary Task from the first turn`
          );
        assert.deepEqual(
          effects.map((effect) => effect.action),
          actions
        );
        assert.ok(effects.every((effect) => effect.selected.windowId === target.windowId));
        for (const index of steps.flatMap((step, index) =>
          ["computer_observe", "computer_wait", "computer_act"].includes(step) ? [index + 1] : []
        )) {
          const content = requests[index].messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content : []
          );
          assert.ok(
            content.some(
              (block) =>
                block.type === "image_url" && block.image_url.url === `data:image/png;base64,${image}`
            ),
            `native PNG absent from model request ${index}`
          );
          const payload = JSON.parse(
            requests[index].messages.findLast((message) => message.role === "tool").content
          );
          const observation = payload.observation ?? payload;
          assert.match(observation.imageRef, /^img_/);
          const stored = await createImageArchive({
            taskDirectory: join(root, "workspace", "computer-agent")
          }).read(observation.imageRef);
          assert.equal(stored.data.toString("base64"), image);
          assert.equal(stored.record.source.kind, "computer");
          assert.equal(stored.record.source.historical, true);
          assert.equal(stored.record.source.sourceObservationId, observation.observationId);
        }
        for (const index of steps.flatMap((step, index) => (step === "computer_act" ? [index + 1] : []))) {
          const result = JSON.parse(
            requests[index].messages.findLast((message) => message.role === "tool").content
          );
          assert.equal(result.dispatched, true);
          assert.equal(result.dispatchStatus, "sent");
          assert.equal(result.effectVerified, false);
          assert.equal(result.requiresObservation, false);
          assert.equal(typeof result.observation.observationId, "string");
          assert.equal(result.observation.image, undefined);
        }
        if (globalPolicy === "run-exit") {
          assert.equal(dashboard.routePorts.computer.current("computer-agent").state, "ended");
          assert.equal(dashboard.routePorts.computer.access().policy.enabled, true);
        } else if (globalPolicy) {
          const finalStatus = JSON.parse(
            requests.at(-1).messages.findLast((message) => message.role === "tool").content
          );
          assert.equal(finalStatus.authorizationRequired, true);
          assert.equal(finalStatus.access.policy.enabled, false);
          assert.match(finalStatus.nextStep, /设置中开启窗口访问/);
          assert.doesNotMatch(finalStatus.nextStep, /会话菜单|并授权/);
          assert.equal(finalStatus.session.state, "ended");
          assert.ok(now > firstExpiresAt);
        }
        assert.equal(
          dashboard.routePorts.computer
            .current("computer-agent")
            .activity.filter((event) => event.outcome === "failed").length,
          0
        );
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
