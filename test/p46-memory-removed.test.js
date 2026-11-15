import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { createModels, createProvider, normalizeContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const { MainRequestStore, mainRequestPath } = await import("../dist/src/storage/main-request-store.js");
const { MainRequestRetry, MainRequestConflictError } =
  await import("../dist/src/runtime/main-request-retry.js");
const { ModelRequestRecorder } = await import("../dist/src/storage/model-request-recorder.js");
const { recordModelRequests } = await import("../dist/src/runtime/model-request-recording.js");
const { createCoworkModel } = await import("../dist/src/runtime/model-profile.js");
const { installedPiVersion } = await import("./pi-version-fixture.mjs");

/**
 * P4.6 #01: user memory, automatic learning and project experience are gone.
 *
 * The claims here are the ones a user can observe: the retired HTTP routes
 * answer 404, Main is not offered the tools or the prompt/context sections, and
 * the requirement ledger is still offered.
 */

const scanRoots = ["src", ".pi", "web", "scripts", "desktop"];
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".md"]);
const skippedDirectories = new Set(["node_modules", "dist", ".git"]);
const retiredIdentifiers = [
  "user-memory",
  "userMemory",
  "UserMemory",
  "manage_user_memory",
  "project-experience",
  "projectExperience",
  "ProjectExperience",
  "PROJECT_EXPERIENCE_ENABLED",
  // The retired system-prompt section names: no request carries one any more.
  "user_memory",
  "project_experience",
  "project_skills",
  "application_context"
];
const retiredModules = [
  "src/domain/user-memory.ts",
  "src/domain/project-experience.ts",
  "src/runtime/user-memory-admission.ts",
  "src/runtime/user-memory-context.ts",
  "src/runtime/user-memory-foreground.ts",
  "src/runtime/user-memory-learning.ts",
  "src/runtime/user-memory-store.ts",
  "src/runtime/user-memory-tools.ts",
  "src/runtime/project-experience-context.ts",
  "src/runtime/project-experience-evidence.ts",
  "src/runtime/project-experience-learning.ts",
  "src/runtime/project-experience-store.ts",
  "src/dashboard/user-memory-routes.ts",
  "src/dashboard/project-experience-routes.ts",
  ".pi/runtime/tools/user-memory.ts",
  "web/assets/controllers/user-memory-settings.js",
  "web/assets/controllers/user-memory-viewer.js",
  "web/assets/controllers/project-experience.js",
  "web/assets/styles/project-experience.css"
];

/** Run one real Main process from this checkout and collect its exit code and output. */
async function runMain({ args, env, stdin }) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name) && name !== "NODE_OPTIONS"
    )
  );
  const child = spawn(process.execPath, ["scripts/start-pi.mjs", ...args], {
    cwd: resolve("."),
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...inherited, ...env }
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  if (stdin !== undefined) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [code] = await once(child, "exit");
  return { code, output };
}

/** The isolated Main environment every fixture here launches with, plus per-run overrides. */
function mainEnvironment(root, overrides) {
  return {
    ATRIA_HOME: join(root, "home"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_WORKSPACE: join(root, "workspace"),
    COWORK_PROJECT_DIR: join(root, "project"),
    COWORK_TASK_ID: "task",
    COWORK_RUN_ID: "run",
    COWORK_MODEL: "protocol-fixture",
    COWORK_MODEL_API: "openai-completions",
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    COWORK_REASONING_EFFORT: "off",
    COWORK_SUPPORTS_REASONING_EFFORT: "0",
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1",
    ...overrides
  };
}

async function* sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && scannedExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))))
      yield path;
  }
}

test("retired memory and experience HTTP routes are gone", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const attempt = (method, path) =>
    fetch(dashboard.base + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ action: "save_text", content: "旧偏好" }) } : {})
    });
  for (const [method, path] of [
    ["GET", "/api/user-memory"],
    ["POST", "/api/user-memory"],
    ["GET", `/api/projects/${dashboard.projectId}/experience`],
    ["POST", `/api/projects/${dashboard.projectId}/experience`]
  ]) {
    const response = await attempt(method, path);
    assert.equal(response.status, 404, `${method} ${path} still answers ${response.status}`);
    await response.text();
  }
  assert.equal((await attempt("GET", "/api/tasks")).status, 200);
});

test(
  "real Main is offered the ledger and no memory or experience context",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-p46-main-"));
    await writeFile(join(root, "config.json"), JSON.stringify({}));
    await mkdir(join(root, "project"), { recursive: true });
    await mkdir(join(root, "workspace"), { recursive: true });
    const dashboard = await startDashboard();
    const steps = [];
    const failures = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      try {
        steps.push(body.messages);
        return { text: "记忆与经验已不再参与本次请求。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "fixture failed" };
      }
    });
    t.after(async () => {
      await provider.close();
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    const { code, output } = await runMain({
      args: [
        "--print",
        "--mode",
        "json",
        "--session-id",
        "run",
        "--session-dir",
        join(root, "sessions"),
        "记录本次请求用的工具与上下文。"
      ],
      env: mainEnvironment(root, {
        COWORK_DASHBOARD_URL: dashboard.base,
        COWORK_API_BASE: provider.baseUrl,
        COWORK_API_KEY: "local-fixture"
      })
    });
    assert.equal(code, 0, output);
    assert.deepEqual(failures, []);
    assert.ok(steps.length >= 1, "Main never reached the model");
    const request = provider.requests[0].body;
    const toolNames = request.tools.map((tool) => tool.function.name);
    assert.ok(toolNames.includes("project_ledger"), `ledger tool missing from ${toolNames.join(", ")}`);
    assert.deepEqual(
      toolNames.filter((name) => /memory|experience/i.test(name)),
      []
    );
    const context = JSON.stringify(request.messages);
    for (const retired of [
      "<user_memory>",
      "user_memory",
      "project_experience",
      "manage_user_memory",
      "项目经验"
    ])
      assert.ok(!context.includes(retired), `Main context still carries ${retired}`);
  }
);

const replayTool = { name: "fixture_tool", description: "Fixture tool", parameters: { type: "object" } };
const replaySystem = (sections) => ({
  role: "system",
  content: "",
  ...(sections ? { sections } : {}),
  timestamp: 1
});

/** One archived failed request plus a retry wired the way the provider boundary wires it. */
async function replayFixture(t, { context, body }) {
  const root = await mkdtemp(join(tmpdir(), "cowork-p46-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MainRequestStore(mainRequestPath(root, "task"), "task");
  const model = createCoworkModel({
    baseUrl: "http://fixture.test",
    model: "fixture",
    supportsReasoningEffort: false
  });
  const executionScope = { version: 1, taskStorageRoot: root, projectDirectory: root, application: null };
  const environment = { projectDirectory: root, binding: "fixture-binding", executionScope };
  await store.begin({
    runId: "run",
    requestId: "request",
    model,
    context,
    environment: { projectDirectory: root, binding: "fixture-binding" },
    executionScope,
    endpoint: "http://fixture.test/v1/chat/completions",
    piVersion: installedPiVersion,
    body
  });
  const retry = new MainRequestRetry(store, "run", async () => environment, "request");
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      name: "Retry fixture",
      baseUrl: model.baseUrl,
      auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "local-fixture" } }) } },
      models: [model],
      api: recordModelRequests(
        openAICompletionsApi(),
        new ModelRequestRecorder(join(root, "archive.jsonl"), {
          taskId: "task",
          runId: "run",
          agentId: "main"
        }),
        retry
      )
    })
  );
  const current = normalizeContext({
    systemPrompt: "Original system",
    tools: [replayTool],
    messages: [{ role: "user", content: "Original input", timestamp: 2 }]
  });
  return { root, store, model, models, current };
}

test("an archived request replays byte for byte", async (t) => {
  const archivedBody = JSON.stringify({
    model: "fixture",
    messages: [
      { role: "system", content: "Original system" },
      { role: "user", content: "Original input" }
    ]
  });
  const f = await replayFixture(t, {
    context: normalizeContext({
      systemPrompt: "Original system",
      tools: [replayTool],
      messages: [replaySystem({ current_workspace: "workspace" })]
    }),
    body: archivedBody
  });
  let sent = 0;
  let transmitted;
  const result = await f.models.completeSimple(f.model, f.current, {
    maxRetries: 0,
    apiKey: "local-fixture",
    fetch: async (_input, init) => {
      sent += 1;
      transmitted = init?.body;
      throw new Error("Unexpected send");
    }
  });
  // The replay reaches the provider boundary with the archived bytes; this
  // fixture's fetch then refuses the transmission, which proves the attempt.
  assert.equal(sent, 1, "a clean archive must still replay");
  assert.equal(transmitted, archivedBody);
  assert.equal(result.stopReason, "error");
});

test("retired memory and experience modules and identifiers are gone", async () => {
  const missing = [];
  for (const path of retiredModules) {
    try {
      await access(resolve(path));
      missing.push(path);
    } catch {
      /* the module is gone, which is the point */
    }
  }
  assert.deepEqual(missing, [], `retired modules still present: ${missing.join(", ")}`);
  const found = [];
  for (const root of scanRoots) {
    for await (const path of sourceFiles(resolve(root))) {
      const text = await readFile(path, "utf8");
      for (const identifier of retiredIdentifiers)
        if (text.includes(identifier))
          found.push(`${relative(resolve("."), path).split(sep).join("/")} → ${identifier}`);
    }
  }
  assert.deepEqual(found, [], `retired identifiers still referenced:\n${found.join("\n")}`);
});
