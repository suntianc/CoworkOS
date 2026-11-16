import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cliHelp, parseCliCommand } from "../dist/src/cli/commands.js";
import { createLoadSkillTool, discoverSkills } from "../dist/src/runtime/skill-registry.js";
import { startDashboard } from "./dashboard-fixture.mjs";
import { RETIRED_GUARDIAN_SWITCH } from "./retired-guardian-switch.mjs";

/**
 * Every capability this product removed stays removed.
 *
 * The table below is the single place that records what is gone: HTTP routes,
 * Pi tools and skills, CLI entry points, and source modules, identifiers and
 * documents. A new removal adds rows here instead of another "the removed thing
 * does not exist" file. What the product still does for users is asserted by the
 * tests that own that behaviour, not here.
 */

const route = (method, path) => ({ kind: "route", method, path });
const tool = (name) => ({ kind: "tool", name });
const skill = (name) => ({ kind: "skill", name });
const command = (name) => ({ kind: "command", name });
const npmScript = (name) => ({ kind: "npmScript", name });
const modulePath = (path) => ({ kind: "module", path });
const fileName = (pattern) => ({ kind: "fileName", pattern });
const term = (text, options = {}) => ({ kind: "identifier", text, ...options });
const pattern = (regexp, label, options = {}) => ({ kind: "identifier", pattern: regexp, label, ...options });
const docFile = (path) => ({ kind: "docFile", path });

/** Product sources the identifier rows scan unless a row names its own files. */
const PRODUCT_ROOTS = ["src", ".pi", "web", "desktop", "scripts"];
const SOURCE_FILE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".md"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

const REMOVED = [
  // HTTP routes from the retired applications, goals, monitoring, memory,
  // science and component-catalogue surfaces.
  route("GET", "/api/applications"),
  route("GET", "/api/resources"),
  route("GET", "/api/components"),
  route("POST", "/api/components/blender/install"),
  route("GET", "/api/applications/blender/runtime"),
  route("POST", "/api/applications/blender/install"),
  route("GET", "/api/workbench/workspaces"),
  route("POST", "/api/workbench/workspaces"),
  route("GET", "/api/workbench/tabs"),
  route("POST", "/api/workbench/tabs"),
  route("GET", "/api/workbench/temporary-resources"),
  route("GET", "/api/workbench/mcp/status"),
  route("GET", "/api/workbench/instances/instance_1"),
  route("POST", "/api/workbench/open-application"),
  route("GET", "/api/tasks/{taskId}/resources"),
  route("POST", "/api/tasks/{taskId}/resources"),
  route("GET", "/api/tasks/{taskId}/app-instances"),
  route("POST", "/api/tasks/{taskId}/app-instances/open"),
  route("GET", "/api/tasks/{taskId}/active-app-context"),
  route("GET", "/api/goals"),
  route("POST", "/api/goals"),
  route("GET", "/api/goals/activity?offset=0"),
  route("GET", "/api/monitors"),
  route("POST", "/api/monitors"),
  route("GET", "/api/tasks/{taskId}/goals"),
  route("POST", "/api/tasks/{taskId}/goals"),
  route("GET", "/api/tasks/{taskId}/monitors"),
  route("POST", "/api/tasks/{taskId}/monitors"),
  route("GET", "/api/user-memory"),
  route("POST", "/api/user-memory"),
  route("GET", "/api/projects/{projectId}/experience"),
  route("POST", "/api/projects/{projectId}/experience"),
  route("GET", "/api/science-settings"),
  route("GET", "/api/science-settings/environments"),
  route("POST", "/api/science-settings/check"),
  route("POST", "/api/science-settings/install"),
  route("POST", "/api/science-settings/cancel"),

  // Pi tools the extension must not register.
  tool("manage_goal"),
  tool("record_goal_progress"),
  tool("publish_goal_update"),
  tool("activate_virtual_agent"),
  tool("create_watcher"),
  tool("manage_user_memory"),
  tool("list_applications"),
  tool("list_resources"),
  tool("list_resource_changes"),
  tool("create_resource"),
  tool("export_resource"),
  tool("apply_resource_operation"),
  tool("accept_resource_candidate"),
  tool("science_search"),
  tool("science_describe"),
  tool("science_run"),
  tool("run_command"),

  // Skills the registry must not discover or load.
  skill("text-editor"),
  skill("cad"),
  skill("blender"),
  skill("pptist"),
  skill("cad-harness"),
  skill("freecad-harness"),
  skill("blender-harness"),
  skill("office-harness"),
  skill("virtual-agent-authoring"),
  skill("parametric-cad"),
  skill("presentations"),
  skill("make-a-deck"),
  skill("office-documents"),

  // CLI entry points and npm scripts.
  command("watch"),
  command("watch-file"),
  command("watch-research"),
  command("watch-run"),
  command("watch-supervisor"),
  command("science"),
  command("data"),
  npmScript("smoke:coding"),
  npmScript("smoke:multi-subagent"),

  // Modules and asset directories that implemented the removed capabilities.
  modulePath("src/applications"),
  modulePath("src/software"),
  modulePath("src/dashboard/application-routes.ts"),
  modulePath(".pi/runtime/application-bridge.ts"),
  modulePath(".pi/runtime/application-skills.ts"),
  modulePath(".pi/runtime/application-tool-execution.ts"),
  modulePath("web/assets/workbench"),
  modulePath("web/assets/controllers/workbench-controller.js"),
  modulePath("src/domain/goal.ts"),
  modulePath("src/domain/watch.ts"),
  modulePath("src/domain/virtual-agent.ts"),
  modulePath("src/dashboard/goal-routes.ts"),
  modulePath("src/dashboard/goal-service.ts"),
  modulePath("src/dashboard/watch-service.ts"),
  modulePath("src/cli/watch-run.ts"),
  modulePath(".pi/runtime/tools/goals.ts"),
  modulePath(".pi/runtime/tools/monitors.ts"),
  modulePath(".pi/skills/virtual-agent-authoring"),
  modulePath("scripts/monitor-service.mjs"),
  modulePath("src/domain/user-memory.ts"),
  modulePath("src/domain/project-experience.ts"),
  modulePath("src/runtime/user-memory-admission.ts"),
  modulePath("src/runtime/user-memory-context.ts"),
  modulePath("src/runtime/user-memory-foreground.ts"),
  modulePath("src/runtime/user-memory-learning.ts"),
  modulePath("src/runtime/user-memory-store.ts"),
  modulePath("src/runtime/user-memory-tools.ts"),
  modulePath("src/runtime/project-experience-context.ts"),
  modulePath("src/runtime/project-experience-evidence.ts"),
  modulePath("src/runtime/project-experience-learning.ts"),
  modulePath("src/runtime/project-experience-store.ts"),
  modulePath("src/dashboard/user-memory-routes.ts"),
  modulePath("src/dashboard/project-experience-routes.ts"),
  modulePath(".pi/runtime/tools/user-memory.ts"),
  modulePath("web/assets/controllers/user-memory-settings.js"),
  modulePath("web/assets/controllers/user-memory-viewer.js"),
  modulePath("web/assets/controllers/project-experience.js"),
  modulePath("web/assets/styles/project-experience.css"),
  modulePath("src/runtime/retired-system-sections.ts"),
  modulePath("src/runtime/model-request-retry.ts"),
  modulePath("scripts/data-migration.cjs"),
  modulePath("src/runtime/pi-session.ts"),
  modulePath("src/runtime/agent-checkpoint.ts"),
  modulePath("src/runtime/context-compaction.ts"),
  modulePath("src/runtime/subagent-recovery-summary.ts"),
  modulePath("src/runtime/run-service.ts"),
  modulePath("src/runtime/worker.ts"),
  modulePath("src/runtime/command-output-feedback.ts"),
  modulePath("src/storage/trace-recorder.ts"),
  modulePath("src/tools/builtin.ts"),
  modulePath("src/tools/foreground-command.ts"),
  modulePath("src/tools/foreground-command-output.ts"),
  modulePath("src/tools/foreground-command-host.ts"),
  modulePath("src/tools/command-receipt.ts"),
  modulePath("src/tools/process-group.ts"),
  modulePath("src/tools/remote-tools.ts"),
  modulePath("src/cli/coding-smoke.ts"),
  modulePath("src/cli/multi-subagent-smoke.ts"),
  modulePath("web/assets/agent-galaxy.js"),
  modulePath("web/assets/agent-galaxy.css"),
  modulePath("web/assets/galaxy-space.js"),
  modulePath("web/assets/agent-room.js"),
  modulePath("web/assets/goal-view.js"),
  modulePath("web/assets/goal.css"),
  modulePath("web/assets/watch.css"),
  modulePath("web/assets/controllers/goal-controller.js"),
  modulePath("web/assets/controllers/goal-form.js"),
  modulePath("web/assets/controllers/watch-controller.js"),
  modulePath("web/assets/work-log.js"),
  modulePath("web/assets/workbench/apps-panel.js"),
  modulePath("web/assets/starfield.js"),
  modulePath("web/assets/starfield.css"),
  modulePath("test/galaxy-space.test.js"),
  modulePath("test/work-log.test.js"),
  modulePath("e2e/appearance-galaxy.spec.js"),
  modulePath("e2e/goal-workspace.spec.js"),
  modulePath("e2e/long-term-goals.spec.js"),
  modulePath("e2e/watchers.spec.js"),
  // No product source file is named after the removed vision role.
  fileName(/(?:^|[-_.])vision/i),

  // Identifiers: application, resource and workbench names.
  term("list_applications"),
  term("list_resources"),
  term("list_resource_changes"),
  term("create_resource"),
  term("export_resource"),
  term("apply_resource_operation"),
  term("accept_resource_candidate"),
  term("/api/workbench"),
  term("/api/applications"),
  term("createWorkbenchController"),
  term("ApplicationService"),
  term("McpSupervisor"),
  term("ResourceMappingStore"),
  term("COWORK_TABS_INDEX"),
  term("boundResourceId"),
  term("loadedInstanceId"),
  term("workbench"),
  term("migrate-resources"),
  term("applications\\/"),
  term("app-instance"),
  term("[data-app-instances]"),
  term("collaboration-picker"),
  term("local-file-opener"),
  term("component-manager"),
  term("component-preparation"),
  term("component-card"),
  term("component-status"),
  term("component-list"),
  term("component-actions"),
  term("component-auth"),
  term("component-details"),
  term("component-progress"),
  term("is-resource"),
  term("resource-review"),
  term("applicationWorkspace"),
  term("drawer-eyebrow"),
  term("drawer-file-list"),
  term("drawer-document"),
  term("drawer-toolbar"),
  term("drawer-file-size"),
  term("editor-name-form"),
  term("editor-surface"),
  term("editor-conflict"),
  term("editor-empty-icon"),
  term("editor-empty-action"),
  term("editor-empty-body"),
  term("editor-state"),
  term("output-heading"),
  term("output-section"),
  term("output-file"),
  term("output-copy"),
  term("output-open-mark"),
  term("openProjectExperience"),
  term("getWorkbench"),
  term("hasResources"),
  term("editAction"),
  term("i-monitor"),
  // The removed page markers, checked on the page that used to carry them.
  ...["apps-nav", "apps-panel", "agent-galaxy", "galaxy-space", "goal.css", "watch.css"].map((marker) =>
    term(marker, { files: ["web/index.html"] })
  ),
  term("starfield"),
  term("night-sky"),
  term("atria.background.motion"),
  term("atria.galaxy.motion"),
  term("星空"),
  term("流星"),

  // Identifiers: goals, monitoring and virtual agents.
  term("manage_goal"),
  term("record_goal_progress"),
  term("publish_goal_update"),
  term("activate_virtual_agent"),
  term("create_watcher"),
  term("GoalManagement"),
  term("GoalActivityStore"),
  term("GoalSupervisor"),
  term("WatchProgramStore"),
  term("WatchManagement"),
  term("WatchSupervisor"),
  term("ScriptWatcher"),
  term("ResearchPollingWatcher"),
  term("FilePollingWatcher"),
  term("WatcherLoop"),
  term("VirtualAgentStore"),
  term("monitoringPrograms"),
  term("backgroundMonitoringPaused"),
  term(RETIRED_GUARDIAN_SWITCH, { roots: ["test", "e2e", "scripts"] }),
  term("COWORK_SUPERVISOR_AUTOSTART"),
  term("COWORK_SUPERVISOR_INTERVAL_MS"),
  term("goalDelegation"),
  term("goal-delegation-request"),
  term("watch-supervisor"),
  term("virtual-agent-authoring"),
  term("长期目标"),
  term("长期任务"),
  term("后台监控会话"),

  // Identifiers: user memory and project experience, including prompt sections.
  term("user-memory"),
  term("userMemory"),
  term("UserMemory"),
  term("manage_user_memory"),
  term("project-experience"),
  term("projectExperience"),
  term("ProjectExperience"),
  term("PROJECT_EXPERIENCE_ENABLED"),
  term("user_memory"),
  term("project_experience"),
  term("project_skills"),
  term("application_context"),

  // Identifiers: pre-release compatibility branches.
  term("RETIRED_SYSTEM_SECTIONS"),
  term("withoutRetiredSections"),
  term("retiredSectionsWithText"),
  term("retiredSectionReplayRefusal"),
  term("isRetiredGoalDecision"),
  term("listBlockingPending"),
  term("pi_version_missing"),
  term("legacyPending"),
  term("readModelRequestRetry"),
  term("model-request-retry"),
  term("retry-request.json"),
  term("human-goal_"),
  term("cowork-completion-check"),
  term("data-migration"),
  term("importLegacyData"),
  term("migrateLegacyDesktopData"),
  term("showLegacyDataNotice"),
  term("canMigrateLegacy"),
  term("legacyUserData"),
  term("data import"),
  term("You are an expert coding assistant operating inside pi"),
  term("Pi documentation (read only when the user asks about pi itself"),
  term("You are Atria Main, the agent responsible for completing the user's tasks in Atria Cowork."),
  // The removed in-process trace path, which nothing writes any more.
  pattern(/sessions\/\$\{[^`]*\}\.jsonl/, "an in-process trace path"),

  // Identifiers: the in-process execution loop.
  term("PiSession"),
  term("CoordinatorWorker"),
  term("createBuiltinTools"),
  term("toolFactory"),
  term("readAgentCheckpoint"),
  term("emptyCompaction"),
  term("PersistedAgentState"),
  term("ContextCompactor"),
  term("subagentRecoverySummary"),
  term("runPi"),
  term("createSubagentStatusTool"),
  term("takeOverLegacyRuntime"),
  pattern(/\bnew Agent\s*[<(]/, "a new pi-agent-core Agent loop"),
  pattern(/\.agent\.(?:run|abort|steer)\s*\(/, "a call into the in-process agent loop"),
  pattern(/\.agent\.state\.isStreaming\b/, "in-process streaming state"),
  pattern(/agentTools\s*[:=]/, "model-visible agent tools"),

  // Identifiers: science capabilities.
  term("science_search"),
  term("science_describe"),
  term("science_run"),
  term("COWORK_SCIENCE_TOOLS"),

  // Identifiers: the removed voice input path.
  // Packaging and signing scripts name the privacy keys they strip or reject,
  // so the voice rows scan the runtime sources rather than those scripts.
  term("mic-button", { roots: ["src", ".pi", "web", "desktop"] }),
  term("#i-mic", { roots: ["src", ".pi", "web", "desktop"] }),
  term("SpeechRecognition", { roots: ["src", ".pi", "web", "desktop"] }),
  term("webkitSpeechRecognition", { roots: ["src", ".pi", "web", "desktop"] }),
  term("createVoiceInput", { roots: ["src", ".pi", "web", "desktop"] }),
  term("voiceInput", { roots: ["src", ".pi", "web", "desktop"] }),
  term("speechInput", { roots: ["src", ".pi", "web", "desktop"] }),
  term("speech-input", { roots: ["src", ".pi", "web", "desktop"] }),
  term("bookman:voice-", { roots: ["src", ".pi", "web", "desktop"] }),

  // Identifiers: the removed vision connection role.
  pattern(/\bvision/i, "a vision role or field"),
  term("图片分析"),
  term("视觉模型"),
  term("视觉连接"),

  // Retired documents.
  docFile("docs/long-term-goals-architecture.md"),
  docFile("docs/long-term-goals-ux.md"),
  docFile("docs/monitoring-pause-contract.md"),
  docFile("docs/watch-program-design.md")
];

/** Maintained documents, and the wording each must not use again. */
const DOCUMENTED = [
  {
    files: ["docs/development.md", "docs/en/development.md", "scripts/docs-site.mjs", "package.json"],
    phrases: [
      "MCP 状态",
      "资源绑定",
      "Resource binding",
      "Tab 索引",
      "应用工作台",
      "application workbench",
      "applications and development",
      "docs/applications.md"
    ]
  },
  {
    files: ["docs/task-workspace-layout.md"],
    phrases: ["goalDelegationRequestId"]
  },
  {
    files: ["src/runtime/AGENTS.md"],
    patterns: [/Task、Run、Agent、Watch、Job/]
  },
  {
    files: [
      "docs/code-map.md",
      "docs/en/code-map.md",
      "docs/runtime-reference.md",
      "docs/en/runtime-reference.md",
      "docs/task-workspace-layout.md",
      "docs/testing-case-catalog.md",
      "docs/computer-use.md"
    ],
    phrases: ["RETIRED_SYSTEM_SECTIONS", "退役段落", "旧快照没有 `piVersion`"],
    patterns: [/pi_version_missing|model-request-retry|retry-request\.json|legacyPending/]
  },
  {
    files: ["docs/visual-observation.md"],
    phrases: ["结果缓存"],
    patterns: [/analysis[- ]result cache/i]
  }
];

/** Removed capability wording a maintained document may not reintroduce. */
const DOCUMENTED_ANYWHERE = [
  "视觉模型",
  "视觉连接",
  "视觉分析",
  "vision model",
  "vision connection",
  "长期目标",
  "应用工作台",
  "starfield",
  "night-sky",
  "星空",
  "流星"
];
/** Documents that record the removal itself are history, not advertising. */
const HISTORY_DOCUMENTS = new Set([
  "docs/development-phases.md",
  "docs/builtin-capabilities.md",
  "docs/en/builtin-capabilities.md",
  "docs/p4.5-retrospective.md"
]);

async function* walkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

/** Source files of every kind the table scans for identifiers. */
async function* walk(directory) {
  for await (const path of walkFiles(directory)) if (SOURCE_FILE.has(extname(path))) yield path;
}

async function productSources() {
  const sources = new Map();
  for (const root of PRODUCT_ROOTS)
    for await (const path of walk(root)) sources.set(path, await readFile(path, "utf8"));
  return sources;
}

function displayPath(path) {
  return relative(resolve("."), path).split(sep).join("/");
}

test("removed HTTP routes answer 404 and a fresh Task keeps the current layout", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const created = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "removed-routes", goal: "确认接口已移除" })
  });
  assert.equal(created.status, 201, await created.text());
  const request = async (method, path) => {
    const response = await fetch(dashboard.base + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {})
    });
    await response.arrayBuffer();
    return response.status;
  };
  for (const row of REMOVED.filter((entry) => entry.kind === "route")) {
    const path = row.path.replace("{taskId}", "removed-routes").replace("{projectId}", dashboard.projectId);
    assert.equal(await request(row.method, path), 404, `${row.method} ${path} still answers`);
  }
  // A fresh Task keeps only the current layout; the retired directories are gone.
  for (const directory of ["watch", "virtual-agents"])
    await assert.rejects(access(join(dashboard.workspaceRoot, "removed-routes", directory)));
  // The host itself still serves the routes that stayed.
  assert.equal(await request("GET", "/api/tasks"), 200);
});

test(
  "the Pi extension, skills registry and CLI offer none of the removed entry points",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-removed-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const previous = { ...process.env };
    t.after(() => {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
    });
    await writeFile(join(root, "config.json"), "{}");
    Object.assign(process.env, {
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: join(root, "workspace"),
      COWORK_TASK_ID: "tool-task",
      COWORK_RUN_ID: "main-tool-task",
      COWORK_DASHBOARD_URL: "http://127.0.0.1:1"
    });
    delete process.env.COWORK_API_BASE;
    delete process.env.COWORK_API_KEY;

    const registered = new Map();
    const pi = {
      on() {},
      registerTool: (entry) => registered.set(entry.name, entry),
      registerProvider() {},
      registerCommand() {},
      getActiveTools: () => [...registered.keys()],
      setActiveTools() {},
      sendMessage: async () => {}
    };
    const extensionPath = resolve(".pi/extensions/cowork.ts");
    const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = await import(requirePi.resolve("jiti"));
    const extension = await createJiti(pathToFileURL(extensionPath).href, {
      interopDefault: true
    }).import(extensionPath, { default: true });
    await (extension.default ?? extension)(pi);
    for (const row of REMOVED.filter((entry) => entry.kind === "tool"))
      assert.equal(registered.has(row.name), false, `${row.name} must not be registered`);

    const skills = await discoverSkills([resolve(".pi/skills")]);
    const loader = createLoadSkillTool(skills);
    for (const row of REMOVED.filter((entry) => entry.kind === "skill"))
      await assert.rejects(loader.execute({ name: row.name }), /unknown skill/, `${row.name} is gone`);

    const help = cliHelp();
    const commandRows = REMOVED.filter((entry) => entry.kind === "command");
    for (const row of commandRows) {
      assert.doesNotMatch(help, new RegExp(`coworkos\\s+${row.name}\\b`), `${row.name} is still in help`);
      assert.throws(() => parseCliCommand(row.name, []), /Unknown command/, `${row.name} is still accepted`);
    }
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    for (const row of REMOVED.filter((entry) => entry.kind === "npmScript"))
      assert.equal(
        Object.hasOwn(packageJson.scripts ?? {}, row.name),
        false,
        `${row.name} is still a script`
      );
  }
);

test("removed modules, files and identifiers are gone from product sources", async () => {
  const present = [];
  for (const row of REMOVED.filter((entry) => entry.kind === "module")) {
    try {
      await access(resolve(row.path));
      present.push(row.path);
    } catch {
      /* the module is gone, which is the point */
    }
  }
  assert.deepEqual(present, [], `retired modules still present: ${present.join(", ")}`);

  const named = [];
  for (const row of REMOVED.filter((entry) => entry.kind === "fileName"))
    for (const root of PRODUCT_ROOTS)
      for await (const path of walkFiles(root))
        if (row.pattern.test(basename(path))) named.push(displayPath(path));
  assert.deepEqual(named, [], `files named after a removed capability:\n${named.join("\n")}`);

  const sources = await productSources();
  const texts = new Map(sources);
  const readAt = async (path) => {
    if (!texts.has(path)) texts.set(path, await readFile(path, "utf8"));
    return texts.get(path);
  };
  const offenders = [];
  for (const row of REMOVED.filter((entry) => entry.kind === "identifier")) {
    let paths;
    if (row.files) paths = row.files;
    else if (row.roots) {
      paths = [];
      for (const root of row.roots) for await (const path of walk(root)) paths.push(path);
    } else paths = [...sources.keys()];
    for (const path of paths) {
      const text = await readAt(path);
      const hit = row.pattern ? row.pattern.test(text) : text.includes(row.text);
      if (hit) offenders.push(`${path} → ${row.pattern ? row.label : row.text}`);
    }
  }
  assert.deepEqual(offenders, [], `removed identifiers still referenced:\n${offenders.join("\n")}`);
});

test("maintained documents do not advertise a removed capability", async () => {
  const retired = [];
  for (const row of REMOVED.filter((entry) => entry.kind === "docFile")) {
    try {
      await access(resolve(row.path));
      retired.push(row.path);
    } catch {
      /* the document is gone, which is the point */
    }
  }
  assert.deepEqual(retired, [], `retired documents still present: ${retired.join(", ")}`);

  const offenders = [];
  for (const scan of DOCUMENTED) {
    for (const file of scan.files) {
      const text = await readFile(resolve(file), "utf8");
      for (const phrase of scan.phrases ?? [])
        if (text.includes(phrase)) offenders.push(`${file} → ${phrase}`);
      for (const scanPattern of scan.patterns ?? [])
        if (scanPattern.test(text)) offenders.push(`${file} → ${scanPattern}`);
    }
  }
  for await (const path of walkFiles("docs")) {
    const normalized = path.split(sep).join("/");
    if (!normalized.endsWith(".md") || HISTORY_DOCUMENTS.has(normalized)) continue;
    const text = await readFile(path, "utf8");
    for (const phrase of DOCUMENTED_ANYWHERE)
      if (text.includes(phrase)) offenders.push(`${normalized} → ${phrase}`);
  }
  assert.deepEqual(offenders, [], `removed capability still advertised:\n${offenders.join("\n")}`);
});
