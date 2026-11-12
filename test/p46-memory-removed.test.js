import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

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
  "user_memory",
  "userMemory",
  "UserMemory",
  "manage_user_memory",
  "project-experience",
  "project_experience",
  "projectExperience",
  "ProjectExperience",
  "PROJECT_EXPERIENCE_ENABLED"
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
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name) && name !== "NODE_OPTIONS"
      )
    );
    const child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        "run",
        "--session-dir",
        join(root, "sessions"),
        "记录本次请求用的工具与上下文。"
      ],
      {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...inherited,
          ATRIA_HOME: join(root, "home"),
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: join(root, "workspace"),
          COWORK_PROJECT_DIR: join(root, "project"),
          COWORK_TASK_ID: "task",
          COWORK_RUN_ID: "run",
          COWORK_DASHBOARD_URL: dashboard.base,
          COWORK_API_BASE: provider.baseUrl,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: "openai-completions",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = once(child, "exit");
    const [code] = await exited;
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
    const child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        "legacy-run",
        "--session-dir",
        join(root, "legacy-sessions"),
        "读一下当前项目状态。"
      ],
      {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...dashboard.env,
          COWORK_PROJECT_DIR: dashboard.workspaceRoot,
          COWORK_TASK_ID: "fresh-session",
          COWORK_RUN_ID: "legacy-run",
          COWORK_API_BASE: provider.baseUrl,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "protocol-fixture",
          COWORK_MODEL_API: "openai-completions",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0"
        }
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "exit");
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
