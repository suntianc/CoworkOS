import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";

const exec = promisify(execFile);
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("delegated image analysis is delivered through a real PiSession and keeps credentials out of the recovery queue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-subagent-vision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "task"));
  await writeFile(join(root, "task", "pixel.png"), pixel);
  const vision = await modelProtocolFixture("openai-completions", () => ({
    text: JSON.stringify({ status: "pass", summary: "Delegated image evidence", issues: [] })
  }));
  t.after(() => vision.close());
  const agent = await modelProtocolFixture("openai-completions", (_body, requests) =>
    requests.length === 1
      ? { name: "read_image", arguments: { path: "pixel.png", scope: "task", review: true } }
      : { text: "Image review completed." }
  );
  t.after(() => agent.close());
  const result = await new CoordinatorRuntime().dispatch({
    taskId: "task",
    runId: "run",
    callId: "call",
    agentId: "image-agent",
    task: "Review pixel.png",
    mode: "sync",
    workspaceRoot: root,
    baseUrl: agent.baseUrl,
    apiKey: "local-agent-secret",
    model: "fixture",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    supportsImages: false,
    timeoutMs: 10000,
    visionModel: { baseUrl: vision.baseUrl, apiKey: "local-vision-secret", model: "fixture" }
  });
  assert.equal(result.status, "succeeded");
  assert.ok(JSON.stringify(agent.requests.at(-1).body).includes("Delegated image evidence"));
  const queue = await readFile(join(root, "task", "runs", "run", "queue.json"), "utf8");
  assert.equal(queue.includes("local-vision-secret"), false);
});
for (const [api, native] of [
  ["openai-completions", false],
  ["openai-completions", true],
  ["openai-responses", false],
  ["openai-responses", true]
])
  test(
    `real Main ${api} read_image: normalized arguments return ${native ? "native pixels" : "separate Responses visual evidence"}`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-vision-pi-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const project = join(root, "project"),
        workspace = join(root, "workspace");
      await mkdir(project);
      await mkdir(workspace);
      await writeFile(join(project, "pixel.png"), pixel);
      const taskImage = "agents/main/work/preview/contact-sheet.png";
      await mkdir(join(workspace, "image-task", "agents", "main", "work", "preview"), { recursive: true });
      await writeFile(join(workspace, "image-task", taskImage), pixel);
      const imageCalls = [
        native ? { paths: ["pixel.png", "pixel.png"] } : { path: "pixel.png", review: true },
        { path: taskImage, paths: [taskImage], scope: "task", review: false },
        { path: taskImage, paths: [""], scope: "task", review: false },
        { path: "", paths: [taskImage], scope: "task", review: false }
      ];
      const vision = await modelProtocolFixture("openai-responses", () => ({
        text: JSON.stringify({ status: "pass", summary: "Pixel fixture reviewed", issues: [] })
      }));
      t.after(() => vision.close());
      const main = await modelProtocolFixture(api, (_body, requests) =>
        requests.length <= imageCalls.length
          ? { name: "read_image", arguments: imageCalls[requests.length - 1] }
          : { text: "Visual evidence accepted." }
      );
      t.after(() => main.close());
      const config = {
        baseUrl: main.baseUrl,
        apiKey: "local-main-key",
        model: "fixture-main",
        api,
        supportsImages: native,
        reasoningEffort: "off",
        supportsReasoningEffort: false,
        modelConnections: {
          version: 1,
          activeId: "main",
          visionId: "vision",
          profiles: [
            {
              id: "main",
              name: "Main",
              baseUrl: main.baseUrl,
              apiKey: "local-main-key",
              model: "fixture-main",
              supportsImages: native,
              api,
              reasoningEffort: "off",
              supportsReasoningEffort: false,
              mainMaxTokens: 8192,
              subagentMaxTokens: 8192
            },
            {
              id: "vision",
              name: "Vision",
              baseUrl: vision.baseUrl,
              apiKey: "local-vision-key",
              model: "fixture-vision",
              supportsImages: true,
              api: "openai-responses",
              reasoningEffort: "off",
              supportsReasoningEffort: false,
              mainMaxTokens: 8192,
              subagentMaxTokens: 8192
            }
          ]
        }
      };
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify(config));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
      );
      const pending = exec(
        process.execPath,
        ["scripts/start-pi.mjs", "--print", "--mode", "json", "Inspect pixel.png and report the evidence."],
        {
          cwd: resolve("."),
          timeout: 35000,
          maxBuffer: 4000000,
          env: {
            ...env,
            // Keep user memory and background work inside this disposable fixture.
            ATRIA_HOME: join(root, "home"),
            COWORK_CONFIG: configPath,
            COWORK_PROJECT_DIR: project,
            COWORK_WORKSPACE: workspace,
            COWORK_TASK_ID: "image-task",
            COWORK_RUN_ID: "image-run",
            PI_CODING_AGENT_DIR: join(root, "pi"),
            COWORK_DISABLE_WATCH_SUPERVISOR: "1",
            PI_OFFLINE: "1"
          }
        }
      );
      pending.child.stdin.end();
      const { stdout, stderr } = await pending;
      assert.ok(stdout.includes("Visual evidence accepted."), stderr);
      assert.equal(main.requests.length, imageCalls.length + 1, "each image read succeeds without retries");
      assert.doesNotMatch(stdout, /Provide exactly one of path or paths/);
      const tools = main.requests[0].body.tools.map((tool) =>
        api === "openai-responses" ? tool : tool.function
      );
      const imageTool = tools.find((tool) => tool.name === "read_image");
      assert.ok(imageTool, "register read_image before the first Main request");
      assert.match(imageTool.parameters.properties.path.description, /one|single/i);
      assert.match(imageTool.description, /Prefer paths:/);
      assert.match(imageTool.parameters.properties.paths.description, /relative image paths/i);
      for (let index = 0; index < imageCalls.length; index++) {
        const request = main.requests[index + 1].body;
        const messages = api === "openai-responses" ? request.input : request.messages;
        const results = messages.filter(
          (message) => message.role === "tool" || message.type === "function_call_output"
        );
        assert.equal(results.length, index + 1);
        const evidence = JSON.stringify(results.at(-1));
        assert.doesNotMatch(evidence, /Provide exactly one|Error|error/i);
        if (index > 0) assert.ok(evidence.includes(taskImage), "keep the Task image path in evidence");
        if (native) {
          const imageParts = messages
            .flatMap((message) => {
              const parts = api === "openai-responses" ? message.output : message.content;
              return Array.isArray(parts) ? parts : [];
            })
            .filter((part) => part.type === (api === "openai-responses" ? "input_image" : "image_url"));
          assert.equal(imageParts.length, index + 2, "aliases must not duplicate an image");
          for (const part of imageParts)
            assert.equal(
              api === "openai-responses" ? part.image_url : part.image_url.url,
              `data:image/png;base64,${pixel.toString("base64")}`
            );
        } else {
          assert.ok(evidence.includes("Pixel fixture reviewed"), "deliver visual evidence after every call");
          assert.equal(JSON.stringify(messages).includes("data:image/png;base64,"), false);
        }
      }
      assert.equal(vision.requests.length, native ? 0 : 2, "reuse the identical Task image evidence");
      const session = await readFile(
        join(workspace, "image-task", "sessions", "main", "image-run-requests.jsonl"),
        "utf8"
      );
      assert.equal(session.includes("local-vision-key"), false);
    }
  );
