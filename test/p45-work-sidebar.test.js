import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { createProjectController } from "../web/assets/controllers/project-controller.js";

const project = (id, tasks = []) => ({
  projectId: id,
  projectName: `项目${id}`,
  projectDirectory: `/tmp/${id}`,
  tasks
});

function fixture(t, records = new Map()) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const $ = (selector) => document.querySelector(selector);
  const state = {
    projects: [],
    tasks: [],
    collapsedProjects: new Set(),
    collapsedSessions: new Set(),
    selectedProjectId: "a",
    selected: null,
    composingNew: false
  };
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, String(value)),
    removeItem: (key) => records.delete(key)
  };
  const controller = createProjectController({
    state,
    $,
    api: async () => ({}),
    storage,
    beginConversation() {},
    selectConversation() {},
    conversationTitle: (task) => task.title || task.goal,
    shortDate: () => "",
    taskMenuOpen: () => false,
    openTaskMenu() {},
    showToast() {},
    getNavigationIdentity: () => "",
    openProjectExperience() {}
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { state, $, controller, storage, records };
}

test("the work tree nests Subagents, marks questions and remembers a folded project", (t) => {
  const records = new Map();
  const first = fixture(t, records);
  const main = {
    taskId: "main-a",
    projectId: "a",
    goal: "评分汇总验收",
    status: "running",
    activity: {
      agents: [
        { agentId: "main", name: "Main", role: "main", state: "running" },
        {
          agentId: "subagent_1",
          name: "Ara",
          role: "subagent",
          workRole: "executor",
          state: "completed"
        },
        {
          agentId: "subagent_2",
          name: "Norma",
          role: "subagent",
          workRole: "reviewer",
          state: "running"
        }
      ]
    }
  };
  const waiting = {
    taskId: "main-b",
    projectId: "a",
    goal: "修复登录超时",
    status: "waiting",
    pendingQuestion: true
  };
  first.controller.accept({ projects: [project("a", [main, waiting])], tasks: [main, waiting] });
  first.controller.render();

  assert.equal(first.$('[data-task="main-a"]').getAttribute("aria-description"), null);
  assert.equal(first.$(".conversation-activity"), null, "the tree shows no stage marker");
  assert.equal(first.$(".subagent-row").textContent.includes("Executor"), true);
  assert.deepEqual(
    [...first.$("#project-list").querySelectorAll(".subagent-row .subagent-name")].map(
      (node) => node.textContent
    ),
    ["Ara", "Norma"]
  );
  assert.deepEqual(
    [...first.$("#project-list").querySelectorAll(".subagent-role")].map((node) => node.textContent),
    ["Executor", "Reviewer"]
  );
  assert.ok(first.$('[data-task="main-b"] .conversation-question'));
  assert.equal(first.$(".project-question"), null, "an expanded project marks the session itself");

  first.$('[data-session-toggle="main-a"]').click();
  assert.equal(first.$('[data-session-toggle="main-a"]').getAttribute("aria-expanded"), "false");
  assert.equal(first.$(".subagent-row"), null);

  first.$("[data-project-id]").click();
  assert.match(first.$('[data-project="a"]').getAttribute("class"), /collapsed/);
  assert.equal(first.$(".project-count").textContent, "2");
  assert.ok(first.$(".project-question"));
  assert.deepEqual(JSON.parse(records.get("atria.collapsed-projects.v1")), ["a"]);

  const reloaded = fixture(t, records);
  reloaded.controller.accept({ projects: [project("a", [main, waiting])], tasks: [main, waiting] });
  reloaded.controller.render();
  assert.match(reloaded.$('[data-project="a"]').getAttribute("class"), /collapsed/);
  assert.equal(reloaded.$(".project-count").textContent, "2");
  assert.equal(reloaded.$('[data-project="a"] .conversation-list') !== null, true);
});

test("an empty catalog shows the project empty state next to the add entry", (t) => {
  const empty = fixture(t);
  empty.controller.accept({ projects: [], tasks: [] });
  empty.controller.render();
  assert.equal(empty.$("#project-list").querySelectorAll(".project-group").length, 0);
  assert.equal(empty.$(".sidebar-empty-state").textContent, "还没有项目");
  assert.equal(empty.controller.visibleProjects().length, 0);
  assert.ok(empty.$("#new-project"), "the section's plus remains the way to add the first project");

  const filled = fixture(t);
  filled.controller.accept({ projects: [project("a")], tasks: [] });
  filled.controller.render();
  assert.equal(filled.$(".sidebar-empty-state"), null);
  assert.equal(filled.controller.visibleProjects().length, 1);
});

test("the catalog reports a pending question only while Main can still be waiting", async (t) => {
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const response = await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "catalog-question", goal: "等待回答" })
  });
  assert.equal(response.status, 201);
  const taskPath = join(dashboard.workspaceRoot, "catalog-question", "task.json");
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  await writeFile(
    taskPath,
    `${JSON.stringify({ ...task, status: "waiting", activeRunId: "run-question" }, null, 2)}\n`
  );
  const requests = join(dashboard.workspaceRoot, "catalog-question", "human", "requests");
  await mkdir(requests, { recursive: true });
  const requestPath = join(requests, "question-1.json");
  await writeFile(
    requestPath,
    `${JSON.stringify({
      requestId: "question-1",
      taskId: "catalog-question",
      runId: "run-question",
      question: "继续合入吗？",
      status: "pending",
      createdAt: new Date().toISOString()
    })}\n`
  );
  const catalog = await (await fetch(`${dashboard.base}/api/tasks`)).json();
  assert.equal(catalog.tasks.find((entry) => entry.taskId === "catalog-question").pendingQuestion, true);

  const settled = JSON.parse(await readFile(requestPath, "utf8"));
  await writeFile(requestPath, `${JSON.stringify({ ...settled, status: "answered", answer: "继续" })}\n`);
  const answered = await (await fetch(`${dashboard.base}/api/tasks`)).json();
  assert.equal(
    "pendingQuestion" in answered.tasks.find((entry) => entry.taskId === "catalog-question"),
    false
  );
});
