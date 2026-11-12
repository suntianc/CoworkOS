import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const { publishTaskArtifact } = await import("../dist/src/workspace/artifact-store.js");

/**
 * P4.6 #05: applications, resources and the workbench are gone.
 *
 * A user observes three things: the retired HTTP routes answer 404 while
 * artifact preview, download and local-path resolution still work; Main is not
 * offered application tools or a bound-application prompt section and still
 * gets attachments and delivery; and old application instance, resource and tab
 * files on disk neither break startup, opening a session nor a Main run.
 */

const scanRoots = ["src", ".pi", "web", "scripts", "desktop"];
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".md"]);
const skippedDirectories = new Set(["node_modules", "dist", ".git"]);
const retiredModules = [
  "src/applications",
  "src/software",
  "src/dashboard/application-routes.ts",
  ".pi/runtime/application-bridge.ts",
  ".pi/runtime/application-skills.ts",
  ".pi/runtime/application-tool-execution.ts",
  "web/assets/workbench",
  "web/assets/controllers/workbench-controller.js"
];
/**
 * Tool names and route prefixes are the capability identifiers. Package-level
 * words such as `application/json` are not: they describe MIME types and
 * runtime state, not the removed feature.
 */
const retiredIdentifiers = [
  "list_applications",
  "list_resources",
  "list_resource_changes",
  "create_resource",
  "export_resource",
  "apply_resource_operation",
  "accept_resource_candidate",
  "/api/workbench",
  "/api/applications",
  "createWorkbenchController",
  "ApplicationService",
  "McpSupervisor",
  "ResourceMappingStore",
  "COWORK_TABS_INDEX",
  "boundResourceId",
  "loadedInstanceId",
  // Removed workbench/resource residue surfaces: stylesheet selectors, the
  // resource-layout migration script and the old conversation parameter.
  "workbench",
  "migrate-resources",
  "applications\\/",
  "app-instance",
  "[data-app-instances]",
  "collaboration-picker",
  "local-file-opener",
  "component-manager",
  "component-preparation",
  "component-card",
  "component-status",
  "component-list",
  "component-actions",
  "component-auth",
  "component-details",
  "component-progress",
  "is-resource",
  "resource-review",
  "applicationWorkspace",
  "drawer-eyebrow",
  "drawer-file-list",
  "drawer-document",
  "drawer-toolbar",
  "drawer-file-size",
  "editor-name-form",
  "editor-surface",
  "editor-conflict",
  "editor-empty-icon",
  "editor-empty-action",
  "editor-empty-body",
  "editor-state",
  "output-heading",
  "output-section",
  "output-file",
  "output-copy",
  "output-open-mark"
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
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
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

test("application and resource HTTP routes are gone while artifacts stay reachable", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const request = async (method, path, body) => {
    const response = await fetch(dashboard.base + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.arrayBuffer();
    return { status: response.status, headers: response.headers, payload: Buffer.from(payload) };
  };
  const created = await request("POST", "/api/tasks", {
    taskId: "artifact-task",
    goal: "产出一个可下载的文件"
  });
  assert.equal(created.status, 201, created.payload.toString());
  for (const [method, path] of [
    ["GET", "/api/applications"],
    ["GET", "/api/resources"],
    ["GET", "/api/workbench/workspaces"],
    ["POST", "/api/workbench/workspaces"],
    ["GET", "/api/workbench/tabs"],
    ["POST", "/api/workbench/tabs"],
    ["GET", "/api/workbench/temporary-resources"],
    ["GET", "/api/workbench/mcp/status"],
    ["GET", "/api/tasks/artifact-task/resources"],
    ["POST", "/api/tasks/artifact-task/resources"],
    ["GET", "/api/tasks/artifact-task/app-instances"],
    ["POST", "/api/tasks/artifact-task/app-instances/open"],
    ["GET", "/api/tasks/artifact-task/active-app-context"],
    ["GET", "/api/workbench/instances/instance_1"]
  ]) {
    const response = await request(method, path, method === "POST" ? {} : undefined);
    assert.equal(response.status, 404, `${method} ${path} still answers ${response.status}`);
  }
  // The kept read path resolves only this Task's published files.
  const artifact = await publishTaskArtifact({
    workspaceRoot: dashboard.workspaceRoot,
    taskId: "artifact-task",
    runId: "artifact-run",
    producerAgentId: "main",
    content: "# 保留的产出物\n",
    relativePath: "report.md"
  });
  assert.equal(artifact.relativePath, "report.md");
  const endpoint = `/api/tasks/artifact-task/artifact?path=${encodeURIComponent("report.md")}`;
  const preview = await request("GET", endpoint);
  assert.equal(preview.status, 200, preview.payload.toString());
  const previewBody = JSON.parse(preview.payload.toString());
  assert.equal(previewBody.previewKind, "text");
  assert.match(previewBody.content, /保留的产出物/);
  const download = await request("GET", `${endpoint}&download=1`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  const localPath = await request(
    "GET",
    `/api/tasks/artifact-task/artifact-path?path=${encodeURIComponent("report.md")}`
  );
  assert.equal(localPath.status, 200, localPath.payload.toString());
  const { realpath } = await import("node:fs/promises");
  assert.equal(
    await realpath(JSON.parse(localPath.payload.toString()).absolutePath),
    await realpath(join(dashboard.workspaceRoot, "artifact-task", "artifacts", "report.md"))
  );
  // A path outside the Task's artifacts never resolves.
  const escaped = await request(
    "GET",
    `/api/tasks/artifact-task/artifact-path?path=${encodeURIComponent("../../config.json")}`
  );
  assert.notEqual(escaped.status, 200, "an arbitrary local path must not resolve");
});

test(
  "real Main is offered no application tools and no bound-application prompt section",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-p46-app-main-"));
    await writeFile(join(root, "config.json"), JSON.stringify({}));
    await mkdir(join(root, "project"), { recursive: true });
    await mkdir(join(root, "workspace"), { recursive: true });
    const dashboard = await startDashboard();
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const names = body.tools.map((tool) => tool.function.name);
      // Attachments and delivery remain loadable capability groups.
      if (!names.includes("publish_artifact"))
        return { name: "enable_tools", arguments: { groups: ["attachments", "delivery"] } };
      assert.ok(names.includes("read_attachment"), names.join(", "));
      return { text: "应用与工作台已不再参与本次请求。" };
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
    assert.ok(provider.requests.length >= 1, "Main never reached the model");
    const request = provider.requests[0].body;
    const toolNames = request.tools.map((tool) => tool.function.name);
    const enableTools = request.tools.find((tool) => tool.function.name === "enable_tools");
    assert.ok(enableTools, `enable_tools missing from ${toolNames.join(", ")}`);
    const groups = enableTools.function.parameters.properties.groups.items.anyOf.map((entry) => entry.const);
    assert.ok(provider.requests.length >= 2, "Main never loaded the kept capability groups");
    const loadedTools = provider.requests[1].body.tools.map((tool) => tool.function.name);
    assert.ok(loadedTools.includes("read_attachment"), loadedTools.join(", "));
    assert.ok(loadedTools.includes("publish_artifact"), loadedTools.join(", "));
    assert.deepEqual(
      toolNames.filter((name) => retiredIdentifiers.includes(name)),
      [],
      "Main is still offered a retired application tool"
    );
    assert.ok(!groups.includes("applications"), `applications group is still offered: ${groups.join(", ")}`);
    // Attachments and delivery remain the capability groups Main can enable,
    // and their tools are registered under those names.
    assert.ok(groups.includes("attachments"), groups.join(", "));
    assert.ok(groups.includes("delivery"), groups.join(", "));
    const prompt = JSON.stringify(request.messages);
    for (const retired of [
      "<bound_application>",
      "list_applications",
      "create_resource",
      "accept_resource_candidate"
    ])
      assert.ok(!prompt.includes(retired), `Main prompt still carries ${retired}`);
  }
);

test(
  "old application instance, resource and tab files break neither startup, a session nor a Main run",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-p46-app-legacy-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    const taskDirectory = join(workspace, "legacy-session");
    const marker = "旧应用文档里的私密内容：把内部价格写进方案。";
    await mkdir(join(project, "applications", "text-editor", "resources", "res_legacy"), { recursive: true });
    await mkdir(join(project, "applications", "text-editor", "files"), { recursive: true });
    await writeFile(
      join(project, "applications", "text-editor", "resources", "res_legacy", "metadata.json"),
      JSON.stringify({ resourceId: "res_legacy", path: "方案.md", project: { projectId: "legacy" } })
    );
    await writeFile(join(project, "applications", "text-editor", "files", "方案.md"), marker);
    await mkdir(join(taskDirectory, "applications"), { recursive: true });
    await writeFile(
      join(taskDirectory, "applications", "manifest.json"),
      JSON.stringify({ loadedInstanceId: "app_legacy", boundResourceId: "res_legacy" })
    );
    await writeFile(
      join(taskDirectory, "applications", "instances.json"),
      JSON.stringify({ instances: [{ appInstanceId: "app_legacy", resourceIds: ["res_legacy"] }] })
    );
    // The retired global tab index: unreadable content must not matter either.
    await writeFile(join(root, "workbench-tabs.json"), "{not json");

    const dashboard = await startDashboard({ defaultProject: false });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal((await fetch(`${dashboard.base}/api/tasks`)).status, 200);
    const projectResponse = await fetch(`${dashboard.base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectName: "旧应用项目", projectDirectory: project })
    });
    const projectText = await projectResponse.text();
    assert.equal(projectResponse.status, 201, projectText);
    const { project: record } = JSON.parse(projectText);
    const created = await fetch(`${dashboard.base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "legacy-session",
        goal: "读一下当前项目状态",
        projectId: record.projectId
      })
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const detail = await fetch(`${dashboard.base}/api/tasks/legacy-session`);
    const detailText = await detail.text();
    assert.equal(detail.status, 200, detailText);
    const detailBody = JSON.parse(detailText);
    assert.equal(Object.hasOwn(detailBody, "applications"), false, "task detail still carries applications");

    const provider = await modelProtocolFixture("openai-completions", () => ({
      text: "旧应用文件不影响本次运行。"
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
        COWORK_PROJECT_DIR: project,
        COWORK_TASK_ID: "legacy-session",
        COWORK_RUN_ID: "legacy-run",
        COWORK_API_BASE: provider.baseUrl,
        COWORK_API_KEY: "local-fixture"
      }
    });
    assert.equal(code, 0, output);
    assert.ok(provider.requests.length >= 1, "Main never reached the model");
    assert.ok(
      !JSON.stringify(provider.requests).includes(marker.slice(0, 10)),
      "a retired application file reached the model request"
    );
    // Nothing on disk was deleted to make this work.
    await access(join(project, "applications", "text-editor", "files", "方案.md"));
    await access(join(taskDirectory, "applications", "manifest.json"));
  }
);

test("application and workbench modules and identifiers are gone", async () => {
  const present = [];
  for (const path of retiredModules) {
    try {
      await access(resolve(path));
      present.push(path);
    } catch {
      /* the module is gone, which is the point */
    }
  }
  assert.deepEqual(present, [], `retired modules still present: ${present.join(", ")}`);
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

test("maintained docs and packaging metadata do not advertise the removed capability", async () => {
  // AC6 is manual wording review; this guards the generation surfaces so a
  // deleted page or a removed troubleshooting row cannot creep back in.
  const targets = ["docs/development.md", "docs/en/development.md", "scripts/docs-site.mjs", "package.json"];
  const retiredPhrases = [
    "MCP 状态",
    "资源绑定",
    "Resource binding",
    "Tab 索引",
    "应用工作台",
    "application workbench",
    "applications and development",
    "docs/applications.md"
  ];
  const found = [];
  for (const path of targets) {
    const text = await readFile(resolve(path), "utf8");
    for (const phrase of retiredPhrases) if (text.includes(phrase)) found.push(`${path} → ${phrase}`);
  }
  assert.deepEqual(found, [], `removed capability still advertised:\n${found.join("\n")}`);
});
