import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { providerConfig } from "./model-provider-fixture.mjs";

const exec = promisify(execFile);
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

for (const api of ["openai-completions", "openai-responses"])
  test(
    `real Main ${api} read_image returns native pixels for every accepted source`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-image-tools-pi-"));
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
        { paths: ["pixel.png", "pixel.png"] },
        { path: taskImage, paths: [taskImage], scope: "task", review: false },
        { path: taskImage, paths: [""], scope: "task", review: false },
        { path: "", paths: [taskImage], scope: "task", review: false }
      ];
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
        supportsImages: true,
        reasoningEffort: "off",
        supportsReasoningEffort: false,
        ...providerConfig([
          {
            id: "main",
            name: "Main",
            baseUrl: main.baseUrl,
            apiKey: "local-main-key",
            model: "fixture-main",
            supportsImages: true,
            api,
            reasoningEffort: "off",
            supportsReasoningEffort: false,
            mainMaxTokens: 8192,
            subagentMaxTokens: 8192
          }
        ])
      };
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify(config));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_)/.test(name))
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
            // Keep every host-owned path inside this disposable fixture.
            ATRIA_HOME: join(root, "home"),
            COWORK_CONFIG: configPath,
            COWORK_PROJECT_DIR: project,
            COWORK_WORKSPACE: workspace,
            COWORK_TASK_ID: "image-task",
            COWORK_RUN_ID: "image-run",
            PI_CODING_AGENT_DIR: join(root, "pi"),
            COWORK_DISABLE_MAIN_GUARDIAN: "1",
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
      }
      const session = await readFile(
        join(workspace, "image-task", "sessions", "main", "image-run-requests.jsonl"),
        "utf8"
      );
      assert.equal(session.includes("local-main-key"), false);
    }
  );
