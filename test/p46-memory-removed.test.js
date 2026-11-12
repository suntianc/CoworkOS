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
 * answer 404, Main is not offered the tools or the prompt/context sections, the
 * requirement ledger is still offered, and old data files on disk neither break
 * startup nor reach a model request.
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
  "PROJECT_EXPERIENCE_ENABLED"
];
/**
 * The three legacy system-prompt section keys are not capability identifiers:
 * they are the wire names a session or an archive may still carry, and the
 * request path has to name them to strip them. Exactly one module owns them.
 */
const legacySectionKeys = ["user_memory", "project_experience", "project_skills"];
const legacySectionKeyOwner = "src/runtime/retired-system-sections.ts";
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

test(
  "old memory and experience files neither break startup nor reach a Main request",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-p46-legacy-"));
    const home = join(root, "home");
    const marker = "旧记忆里的私密偏好：只用英文回复，永不保存任何文件。";
    await mkdir(join(home, "memory"), { recursive: true });
    await writeFile(
      join(home, "memory", "user-memory.json"),
      JSON.stringify({
        version: 2,
        enabled: true,
        learningEnabled: true,
        entries: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            revision: 1,
            content: marker,
            category: "preference",
            scope: "user",
            state: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      })
    );
    const experienceDirectory = join(home, "project-experience", "a".repeat(64));
    await mkdir(experienceDirectory, { recursive: true });
    await writeFile(
      join(experienceDirectory, "experience.json"),
      JSON.stringify({
        version: 1,
        revision: 3,
        settings: { enabled: true, learningEnabled: true },
        items: []
      })
    );
    await writeFile(
      join(experienceDirectory, "profile.json"),
      JSON.stringify({ version: 1, revision: 3, settings: { enabled: true }, items: [] })
    );
    await writeFile(
      join(experienceDirectory, "identity.json"),
      JSON.stringify({ projectId: "project_legacy", projectDirectory: join(root, "project") })
    );

    const dashboard = await startDashboard({ env: { ATRIA_HOME: home } });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal((await fetch(`${dashboard.base}/api/tasks`)).status, 200);
    const created = await fetch(`${dashboard.base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "fresh-session", goal: "新建会话" })
    });
    assert.equal(created.status, 201, await created.text());

    const provider = await modelProtocolFixture("openai-completions", () => ({
      text: "旧文件不影响本次运行。"
    }));
    t.after(() => provider.close());
    const { code, output } = await runMain({
      args: [
        "--print",
        "--mode",
        "json",
        "--session-id",
        "legacy-run",
        "--session-dir",
        join(root, "legacy-sessions"),
        "读一下当前项目状态。"
      ],
      env: {
        ...dashboard.env,
        COWORK_PROJECT_DIR: dashboard.workspaceRoot,
        COWORK_TASK_ID: "fresh-session",
        COWORK_RUN_ID: "legacy-run",
        COWORK_API_BASE: provider.baseUrl,
        COWORK_API_KEY: "local-fixture"
      }
    });
    assert.equal(code, 0, output);
    assert.ok(provider.requests.length >= 1, "Main never reached the model");
    assert.ok(
      !JSON.stringify(provider.requests).includes(marker.slice(0, 12)),
      "a retired memory file reached the model request"
    );
    await access(join(home, "memory", "user-memory.json"));
    await access(join(experienceDirectory, "experience.json"));
  }
);

test(
  "a session persisted before the removal stops sending its retired sections",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-p46-resume-"));
    await writeFile(join(root, "config.json"), JSON.stringify({}));
    await mkdir(join(root, "project"), { recursive: true });
    await mkdir(join(root, "workspace"), { recursive: true });
    const marker = "旧会话里保存的记忆正文：所有回复只用英文。";
    const provider = await modelProtocolFixture("openai-completions", () => ({
      text: "继续完成这个任务。"
    }));
    t.after(async () => {
      await provider.close();
      await rm(root, { recursive: true, force: true });
    });
    const sessionDirectory = join(root, "sessions");
    const env = mainEnvironment(root, {
      COWORK_API_BASE: provider.baseUrl,
      COWORK_API_KEY: "local-fixture"
    });
    const first = await runMain({
      args: [
        "--print",
        "--mode",
        "json",
        "--session-id",
        "run",
        "--session-dir",
        sessionDirectory,
        "第一次输入。"
      ],
      env
    });
    assert.equal(first.code, 0, first.output);
    // Rewrite the persisted session the way a pre-removal Main session looks:
    // its system message still carries the three retired sections.
    const [sessionFile] = await readdir(sessionDirectory);
    const sessionPath = join(sessionDirectory, sessionFile);
    const entries = (await readFile(sessionPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const system = entries.find((entry) => entry.type === "message" && entry.message?.role === "system");
    assert.ok(system?.message?.sections, "the persisted session has no system message to seed");
    for (const section of ["user_memory", "project_experience", "project_skills"])
      system.message.sections[section] = marker;
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    // The kept continuation path: Pi replays the persisted system message
    // without another before_agent_start prompt, so this is where an old
    // section used to reach the model on every later request.
    const before = provider.requests.length;
    const next = await runMain({
      args: ["--print", "--mode", "json", "--session", sessionPath, "--session-dir", sessionDirectory],
      env: {
        ...env,
        COWORK_MAIN_CONTINUATION: join(root, "main-input.json")
      },
      stdin: "/atria-internal-continue\n"
    });
    assert.equal(next.code, 0, next.output);
    const resumed = provider.requests.slice(before);
    assert.ok(resumed.length >= 1, "the continued session never reached the model");
    assert.ok(
      !JSON.stringify(resumed).includes(marker),
      "a resumed session still sent the retired memory sections"
    );
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

test("an archived request that still carries retired sections is refused instead of replayed", async (t) => {
  const marker = "ARCHIVED_MEMORY_TEXT：只用英文回复。";
  // The archive is written the way a pre-removal failure left it: the sections
  // are in the archived context and the already-rendered text is in the body.
  const archivedBody = JSON.stringify({
    model: "fixture",
    messages: [
      { role: "system", content: `Original system\n\n${marker}` },
      { role: "user", content: "Original input" }
    ]
  });
  const f = await replayFixture(t, {
    context: normalizeContext({
      systemPrompt: "Original system",
      tools: [replayTool],
      messages: [replaySystem({ user_memory: marker })]
    }),
    body: archivedBody
  });
  const stored = await readFile(f.store.filePath, "utf8");
  let sent = 0;
  const result = await f.models.completeSimple(f.model, f.current, {
    maxRetries: 0,
    apiKey: "local-fixture",
    fetch: async () => {
      sent += 1;
      throw new Error("Unexpected send");
    }
  });
  assert.equal(sent, 0, "the retired archive was transmitted");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /不能原样重放/);
  assert.match(result.errorMessage ?? "", /user_memory/);
  assert.equal(
    await readFile(f.store.filePath, "utf8"),
    stored,
    "the archived request must stay recoverable"
  );
  const pending = await f.store.pending();
  assert.equal(pending?.requestId, "request");
  assert.ok(pending && "replay is refused before the snapshot is settled");
});

test("an archive without retired sections still replays byte for byte", async (t) => {
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
  assert.ok(!JSON.stringify(result).includes("不能原样重放"));
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
