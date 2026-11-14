import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { startDashboard } from "./dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InputStore, inputPrompt } from "../dist/src/workspace/input-store.js";
import { createImageTools } from "../dist/src/tools/read-image.js";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const pixelBytes = Buffer.from(pixel, "base64");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const capabilitiesPath = resolve(".pi/runtime/tools/capabilities.ts");
const { registerCapabilityTools, CORE_TOOLS } = await createJiti(pathToFileURL(capabilitiesPath).href).import(
  capabilitiesPath
);

test("a removed vision role in the saved configuration is ignored by startup and model settings", async (t) => {
  const dashboard = await startDashboard({
    config: {
      baseUrl: "http://legacy.example/v1",
      model: "legacy-main",
      apiKey: "local-legacy-key",
      modelConnections: {
        version: 1,
        activeId: "main",
        visionId: "removed-vision-profile",
        profiles: [
          {
            id: "main",
            name: "Main",
            baseUrl: "http://legacy.example/v1",
            apiKey: "local-legacy-key",
            model: "legacy-main",
            api: "openai-completions",
            supportsImages: false
          }
        ]
      }
    }
  });
  t.after(() => dashboard.stop());
  const response = await fetch(`${dashboard.base}/api/model-settings`);
  assert.equal(response.status, 200, "a stale vision role must not stop the host or settings");
  const status = await response.json();
  assert.equal(Object.hasOwn(status, "visionProfileId"), false);
  for (const profile of status.profiles) {
    assert.equal(Object.hasOwn(profile, "vision"), false);
    assert.equal(typeof profile.supportsImages, "boolean");
  }
  assert.equal(status.activeProfileId, "main");
  // The removed field is not accepted as a new role either.
  const saved = await fetch(`${dashboard.base}/api/model-settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileId: "main",
      profileName: "Main",
      baseUrl: "http://legacy.example/v1",
      model: "legacy-main",
      api: "openai-completions",
      supportsImages: true,
      vision: true
    })
  });
  assert.equal(saved.status, 200);
  const next = await saved.json();
  assert.equal(Object.hasOwn(next, "visionProfileId"), false);
  assert.equal(Object.hasOwn(next.profiles[0], "vision"), false);
  const persisted = JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(persisted.modelConnections, "visionId"), false);
  assert.equal(persisted.modelConnections.profiles[0].supportsImages, true);
});

test("a text-only read_image refuses pixels without contacting any other model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p46-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixelBytes);
  const tool = createImageTools({ rootDirectory: root, taskDirectory: root }).read_image;
  await assert.rejects(tool.execute({ path: "pixel.png" }), /当前模型不支持图片/);
  await assert.rejects(
    createImageTools({ rootDirectory: root, taskDirectory: root }).read_images.execute({
      images: [{ path: "pixel.png" }]
    }),
    /当前模型不支持图片/
  );
  await assert.rejects(
    createImageTools({ rootDirectory: root, taskDirectory: root }).crop_image.execute({
      path: "pixel.png",
      region: { x: 0, y: 0, width: 1, height: 1 }
    }),
    /当前模型不支持图片/
  );
});

test("desktop, browser and CUA tools require a Main connection that accepts image input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p46-capabilities-"));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task");
  await store.createRun("task", "run");
  const previous = { ...process.env };
  for (const name of ["COWORK_DASHBOARD_URL", "COWORK_API_TOKEN", "COWORK_PROJECT_WRITE"])
    delete process.env[name];
  t.after(async () => {
    for (const name of ["COWORK_DASHBOARD_URL", "COWORK_API_TOKEN", "COWORK_PROJECT_WRITE"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(root, { recursive: true, force: true });
  });
  const imageTools = [
    "browser_open",
    "browser_observe",
    "browser_act",
    "browser_wait",
    "browser_close",
    "cua_script",
    "cua_reset",
    "computer_status",
    "computer_observe",
    "computer_wait",
    "computer_act"
  ];
  const start = (supportsImages) => {
    let active = ["read", "write", "edit", "bash", ...CORE_TOOLS];
    const tools = new Map();
    const pi = {
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
      registerTool: (tool) => tools.set(tool.name, tool)
    };
    const controller = registerCapabilityTools(pi, {
      workspaceRoot: root,
      taskId: "task",
      mainRunId: "run",
      supportsImages
    });
    return {
      controller,
      pi,
      enable: (groups) => tools.get("enable_tools").execute("load", { groups })
    };
  };
  const textOnly = start(false);
  const requested = await textOnly.enable(["browser", "cua", "computer"]);
  for (const name of ["browser", "cua", "computer"])
    assert.equal(requested.details.groups[name].enabled, false);
  for (const name of imageTools) assert.equal(textOnly.pi.getActiveTools().includes(name), false);
  await textOnly.controller.refresh();
  for (const name of imageTools) assert.equal(textOnly.pi.getActiveTools().includes(name), false);

  const imageCapable = start(true);
  const available = await imageCapable.enable(["browser", "cua"]);
  assert.equal(available.details.groups.browser.enabled, true);
  assert.equal(available.details.groups.cua.enabled, true);
  // The desktop host is absent here, so only the always-safe status tool loads.
  for (const name of ["browser_open", "browser_wait", "cua_script", "cua_reset"])
    assert.ok(imageCapable.pi.getActiveTools().includes(name), `${name} stays available`);
  for (const name of ["computer_observe", "computer_act"])
    assert.equal(imageCapable.pi.getActiveTools().includes(name), false);
});

/** A real Main process against a strict local provider; the handler picks each reply. */
async function runMain(t, { supportsImages, reply }) {
  const root = await mkdtemp(join(tmpdir(), "atria-p46-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"),
    workspace = join(root, "workspace");
  await mkdir(project);
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask("image-task", { goal: "读取图片附件" });
  await store.createRun("image-task", "image-run");
  await writeFile(join(root, "config.json"), "{}");
  const uploads = new InputStore(join(root, "uploads"));
  const image = await uploads.receive("截图.png", Readable.from([pixelBytes]));
  await uploads.attach(workspace, "image-task", [image.uploadId]);
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const step = requests.length;
    const tool = step === 1 ? { name: "read_attachment", arguments: { id: image.uploadId } } : undefined;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `p46-${step}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "p46-fixture",
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`
      );
    send({ role: "assistant" });
    if (tool) {
      send({
        tool_calls: [
          {
            index: 0,
            id: `p46-call-${step}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) }
          }
        ]
      });
      send({}, "tool_calls");
    } else {
      send({ content: reply });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const pending = spawn(
    process.execPath,
    [
      "scripts/start-pi.mjs",
      "--print",
      "--mode",
      "json",
      "--session-id",
      "image-run",
      "--session-dir",
      join(root, "sessions"),
      "读取这张图片并说明结果。" + inputPrompt(join(workspace, "image-task"), [image])
    ],
    {
      cwd: resolve("."),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_)/.test(name))
        ),
        COWORK_CONFIG: join(root, "config.json"),
        COWORK_WORKSPACE: workspace,
        COWORK_PROJECT_DIR: project,
        COWORK_TASK_ID: "image-task",
        COWORK_RUN_ID: "image-run",
        COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
        COWORK_API_KEY: "local-p46-key",
        COWORK_MODEL: "p46-fixture",
        COWORK_MODEL_API: "openai-completions",
        COWORK_DASHBOARD_URL: "",
        COWORK_DISABLE_MAIN_GUARDIAN: "1",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        COWORK_SUPPORTS_IMAGES: supportsImages ? "1" : "0",
        ATRIA_HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1"
      }
    }
  );
  t.after(async () => {
    if (pending.pid && pending.exitCode === null) {
      try {
        process.kill(-pending.pid, "SIGKILL");
      } catch {
        // The run already exited.
      }
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  let output = "";
  const record = (chunk) => {
    output = (output + chunk).slice(-20000);
  };
  pending.stdout.on("data", record);
  pending.stderr.on("data", record);
  const [code] = await once(pending, "exit");
  assert.equal(code, 0, output);
  return { requests, output, uploadId: image.uploadId };
}

test(
  "a text-only Main never sends uploaded image pixels and reports the missing capability",
  { timeout: 60_000 },
  async (t) => {
    const result = await runMain(t, {
      supportsImages: false,
      reply: "当前模型不支持图片，图片未发送。"
    });
    assert.ok(result.output.includes("当前模型不支持图片"), result.output);
    for (const request of result.requests)
      assert.equal(JSON.stringify(request).includes(pixel), false, "no request may carry the pixels");
    assert.equal(result.requests.length, 2, result.output);
    const toolResult = JSON.stringify(
      result.requests[1].messages.findLast((message) => message.role === "tool")
    );
    assert.match(toolResult, /当前模型不支持图片/);
  }
);

test(
  "an image-capable Main sends uploaded image pixels to the current model",
  { timeout: 60_000 },
  async (t) => {
    const result = await runMain(t, { supportsImages: true, reply: "已读取图片。" });
    assert.equal(result.requests.length, 2, result.output);
    assert.ok(
      JSON.stringify(result.requests[1].messages).includes(`data:image/png;base64,${pixel}`),
      "the current model receives the uploaded pixels"
    );
  }
);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

test("no vision module or identifier remains in product sources", async () => {
  const files = (await Promise.all(["src", ".pi", "web", "scripts", "desktop"].map(walk))).flat();
  const visionFiles = files.filter((path) => /(?:^|[-_.])vision/i.test(path.split("/").at(-1)));
  assert.deepEqual(visionFiles, [], "vision modules are removed");
  const sourceFiles = files.filter((path) => /\.(?:ts|tsx|js|mjs|cjs|json|css|html|md)$/.test(path));
  const offenders = [];
  for (const path of sourceFiles) {
    const text = await readFile(path, "utf8");
    const words = text.split(/[^A-Za-z0-9]+/);
    if (
      words.some((word) => word.toLowerCase().startsWith("vision")) ||
      /图片分析|视觉模型|视觉连接/.test(text)
    )
      offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test("product documentation names no removed vision capability", async () => {
  const docs = (await walk("docs")).filter((path) => path.endsWith(".md"));
  const offenders = [];
  for (const path of docs) {
    // The phase plan and the removed-capability list record the removal itself,
    // so they may name what was removed.
    if (path.endsWith("development-phases.md") || path.endsWith("builtin-capabilities.md")) continue;
    const text = await readFile(path, "utf8");
    for (const term of ["视觉模型", "视觉连接", "视觉分析", "vision model", "vision connection"])
      if (text.includes(term)) offenders.push(`${path}: ${term}`);
  }
  // The host stores model and search credentials only; the export paragraph must not list a vision kind.
  const exportDoc = await readFile("docs/task-workspace-layout.md", "utf8");
  const redaction = exportDoc
    .split("\n")
    .find((line) => line.includes("credentials.json") && line.includes("脱敏"));
  assert.ok(redaction, "the session export redaction paragraph must exist");
  if (redaction.includes("视觉")) offenders.push("docs/task-workspace-layout.md: vision credential");
  // Image reads archive pixels; only the removed vision model cached analysis results.
  const imageDoc = await readFile("docs/visual-observation.md", "utf8");
  if (imageDoc.includes("结果缓存") || /analysis[- ]result cache/i.test(imageDoc))
    offenders.push("docs/visual-observation.md: analysis result cache");
  assert.deepEqual(offenders, []);
});
