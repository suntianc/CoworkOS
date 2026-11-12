import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PNG } from "pngjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { createImageArchive } from "../dist/src/tools/image-archive.js";
import { cropPng } from "../dist/src/tools/image-crop.js";

const exec = promisify(execFile);
function screenshot() {
  const image = new PNG({ width: 6, height: 4 });
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 6; x++) image.data.set([x * 30, y * 40, 0, 255], (y * 6 + x) * 4);
  return PNG.sync.write(image);
}
function replySequence(scope) {
  let cropRef;
  return {
    get cropRef() {
      return cropRef;
    },
    handle(body, requests) {
      const text = JSON.stringify(body.messages);
      if (requests.length === 1)
        return {
          name: "crop_image",
          arguments: { path: "frame.png", scope, region: { x: 1, y: 1, width: 2, height: 2 }, scale: 2 }
        };
      if (requests.length === 2) {
        // Tool evidence exposes the new reference in its first metadata object.
        const contents = body.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content)
          .flat();
        const metadata = contents
          .filter((block) => typeof block === "string" || block?.type === "text")
          .map((block) => (typeof block === "string" ? block : block.text))
          .join("\n");
        const matches = [...metadata.matchAll(/"imageRef":"(img_[0-9a-f-]+)"/g)];
        cropRef = matches.at(-1)?.[1];
        assert.ok(cropRef, metadata);
        return { name: "read_image", arguments: { imageRef: cropRef } };
      }
      if (requests.length === 3)
        return {
          name: "read_images",
          arguments: { images: [{ path: "frame.png", scope }, { imageRef: cropRef }] }
        };
      if (requests.length === 4) return { name: "list_images", arguments: { limit: 10 } };
      assert.ok(text.includes(cropRef));
      return { text: "Crop reread and visual comparison completed." };
    }
  };
}

for (const main of [false, true])
  test(
    `real ${main ? "Main extension" : "delegated PiSession"}: crop → reference reread → multiple images → archive history`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-visual-tools-pi-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const project = join(root, "project"),
        workspace = join(root, "workspace"),
        task = join(workspace, "visual-task");
      await mkdir(project);
      await mkdir(task, { recursive: true });
      const data = screenshot();
      await writeFile(join(main ? project : task, "frame.png"), data);
      const sequence = replySequence(main ? "project" : "task");
      const provider = await modelProtocolFixture("openai-completions", (body, requests) =>
        sequence.handle(body, requests)
      );
      t.after(() => provider.close());
      const connection = {
        baseUrl: provider.baseUrl,
        apiKey: "local-visual-fixture-key",
        model: "fixture-main",
        supportsImages: true,
        reasoningEffort: "off",
        supportsReasoningEffort: false
      };
      if (main) {
        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify(connection));
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
        );
        const pending = exec(
          process.execPath,
          [
            "scripts/start-pi.mjs",
            "--print",
            "--mode",
            "json",
            "Crop the screenshot, reread it, compare both and list image history."
          ],
          {
            cwd: resolve("."),
            timeout: 35000,
            maxBuffer: 4000000,
            env: {
              ...env,
              COWORK_CONFIG: configPath,
              COWORK_PROJECT_DIR: project,
              COWORK_WORKSPACE: workspace,
              COWORK_TASK_ID: "visual-task",
              COWORK_RUN_ID: "visual-run",
              PI_CODING_AGENT_DIR: join(root, "pi"),
              COWORK_DISABLE_MAIN_GUARDIAN: "1",
              PI_OFFLINE: "1"
            }
          }
        );
        pending.child.stdin.end();
        const { stdout, stderr } = await pending;
        assert.ok(stdout.includes("visual comparison completed."), stderr);
      } else {
        const result = await new CoordinatorRuntime().dispatch({
          taskId: "visual-task",
          runId: "visual-run",
          callId: "visual-call",
          agentId: "visual-agent",
          task: "Crop and compare frame.png",
          mode: "sync",
          workspaceRoot: workspace,
          ...connection,
          thinkingLevel: "off",
          timeoutMs: 15000
        });
        assert.equal(result.status, "succeeded");
      }
      const names = provider.requests[0].body.tools.map((tool) => tool.function.name);
      for (const name of ["read_image", "crop_image", "read_images", "list_images"])
        assert.ok(names.includes(name), `${name} was not discoverable`);
      assert.equal(provider.requests.length, 5);
      const expected = cropPng({ data, region: { x: 1, y: 1, width: 2, height: 2 }, scale: 2 });
      const wire = JSON.stringify(provider.requests[3].body.messages);
      assert.ok(wire.includes(expected.data.toString("base64")), "Cropped pixels did not reach the model");
      assert.ok(wire.includes(data.toString("base64")), "Full screenshot did not reach the model");
      const archive = createImageArchive({ taskDirectory: task });
      const record = await archive.read(sequence.cropRef);
      assert.deepEqual(record.data, expected.data);
      assert.equal(record.record.mapping.region.x, 1);
      assert.equal(record.record.mapping.scaleX, 2);
      assert.equal(record.record.observationId, undefined);
      assert.equal((await archive.list()).length, 3);
    }
  );

for (const main of [false, true])
  test(
    `real ${main ? "Main" : "delegated"} Pi accepts empty/null unused image sources and rejects genuinely conflicting sources`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-visual-source-pi-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const project = join(root, "project"),
        workspace = join(root, "workspace"),
        task = join(workspace, "visual-task");
      await mkdir(project);
      await mkdir(task, { recursive: true });
      const data = screenshot();
      await writeFile(join(main ? project : task, "frame.png"), data);
      const archive = createImageArchive({ taskDirectory: task });
      const source = await archive.put({ data, mimeType: "image/png" });
      const scope = main ? "project" : "task";
      const region = { x: 1, y: 1, width: 2, height: 2 };
      const results = [];
      let cropRef;
      const provider = await modelProtocolFixture("openai-completions", (body, requests) => {
        const last = body.messages.findLast((message) => message.role === "tool");
        if (last) results.push(last.content);
        if (requests.length === 2)
          cropRef = [...last.content.matchAll(/"imageRef":"(img_[0-9a-f-]+)"/g)].at(-1)?.[1];
        const imageRef = cropRef ?? source.imageRef;
        const replies = [
          {
            name: "crop_image",
            arguments: { path: "", imageRef: source.imageRef, scope: "task", region, scale: 2 }
          },
          { name: "read_image", arguments: { path: null, imageRef, scope: "task" } },
          {
            name: "read_images",
            arguments: {
              images: [
                { path: "frame.png", imageRef: "", scope },
                { path: "", imageRef, scope: "task" }
              ]
            }
          },
          {
            name: "crop_image",
            arguments: { path: null, imageRef: source.imageRef, scope: "task", region, scale: 2 }
          },
          { name: "read_image", arguments: { path: "frame.png", imageRef: null, scope } },
          { name: "read_image", arguments: { path: "frame.png", imageRef: source.imageRef, scope } },
          {
            name: "crop_image",
            arguments: { path: "/", imageRef: source.imageRef, scope: "task", region, scale: 2 }
          },
          {
            name: "read_images",
            arguments: { images: [{ path: "frame.png", imageRef: source.imageRef, scope }] }
          },
          { name: "read_image", arguments: { path: "", imageRef: "" } }
        ];
        return replies[requests.length - 1] ?? { text: "IMAGE_SOURCE_COMPATIBILITY_VERIFIED" };
      });
      t.after(() => provider.close());
      const connection = {
        baseUrl: provider.baseUrl,
        apiKey: "local-image-source-fixture",
        model: "fixture",
        supportsImages: true,
        reasoningEffort: "off",
        supportsReasoningEffort: false
      };
      if (main) {
        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify(connection));
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
        );
        const pending = exec(
          process.execPath,
          [
            "scripts/start-pi.mjs",
            "--print",
            "--mode",
            "json",
            "Inspect images using exactly one meaningful source."
          ],
          {
            cwd: resolve("."),
            timeout: 35000,
            maxBuffer: 4000000,
            env: {
              ...env,
              COWORK_CONFIG: configPath,
              COWORK_PROJECT_DIR: project,
              COWORK_WORKSPACE: workspace,
              COWORK_TASK_ID: "visual-task",
              COWORK_RUN_ID: "visual-source-run",
              PI_CODING_AGENT_DIR: join(root, "pi"),
              COWORK_DISABLE_MAIN_GUARDIAN: "1",
              PI_OFFLINE: "1"
            }
          }
        );
        pending.child.stdin.end();
        const { stdout, stderr } = await pending;
        assert.ok(stdout.includes("IMAGE_SOURCE_COMPATIBILITY_VERIFIED"), stderr);
      } else {
        const result = await new CoordinatorRuntime().dispatch({
          taskId: "visual-task",
          runId: "visual-source-run",
          callId: "visual-source-call",
          agentId: "visual-agent",
          task: "Inspect images using exactly one meaningful source.",
          mode: "sync",
          workspaceRoot: workspace,
          ...connection,
          thinkingLevel: "off",
          timeoutMs: 15000
        });
        assert.equal(result.status, "succeeded");
      }
      assert.equal(provider.requests.length, 10);
      assert.match(results[0], /Image loaded/, "empty path + valid imageRef failed to crop");
      assert.ok(cropRef && cropRef !== source.imageRef);
      assert.match(results[1], /Image loaded/);
      assert.match(results[2], /Image 1 of 2/);
      assert.match(results[3], /Image loaded/);
      assert.match(results[4], /Image loaded/);
      for (const value of results.slice(5)) assert.match(value, /Specify exactly one path or imageRef/);
      const cropped = cropPng({ data, region, scale: 2 }).data;
      assert.deepEqual((await archive.read(cropRef)).data, cropped);
      const expectedImages = [[cropped], [cropped], [data, cropped], [cropped], [data]];
      for (const [index, request] of provider.requests.slice(1).entries()) {
        const lastTool = request.body.messages.findLastIndex((message) => message.role === "tool");
        const delivered = request.body.messages
          .slice(lastTool + 1)
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((block) => block.type === "image_url")
          .map((block) => Buffer.from(block.image_url.url.split(",")[1], "base64"));
        assert.deepEqual(
          delivered,
          expectedImages[index] ?? [],
          `tool result ${index + 1} did not deliver its own expected pixels`
        );
      }
      const tools = new Map(
        provider.requests[0].body.tools.map((tool) => [tool.function.name, tool.function])
      );
      for (const name of ["read_image", "crop_image", "read_images"]) {
        const fields =
          name === "read_images"
            ? tools.get(name).parameters.properties.images.items.properties
            : tools.get(name).parameters.properties;
        for (const key of ["path", "imageRef"]) {
          assert.deepEqual(
            fields[key].type,
            ["string", "null"],
            `${name}.${key} lacks a null representation`
          );
          assert.match(fields[key].description, /other|exactly one/);
        }
      }
      assert.match(tools.get("crop_image").description, /exactly one/i);
    }
  );
