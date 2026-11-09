import { confirmApplicationWorkspaceInDom } from "./application-workspace-choice.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NodeFilter, parseHTML } from "linkedom";

/**
 * Boot the whole page the way a browser does.
 *
 * Every other test imports a module directly, so a broken import *in `app.js`
 * itself* — a name that no longer exists, a variable that was never declared —
 * left every suite green while the real page failed to load and nothing on
 * screen worked at all. This is the only test that actually executes `app.js`,
 * which is exactly the gap those failures fell through.
 */
function browserEnvironment() {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = {
    ...Object.fromEntries(
      [
        "document",
        "window",
        "NodeFilter",
        "CSS",
        "EventSource",
        "ResizeObserver",
        "IntersectionObserver",
        "MutationObserver",
        "devicePixelRatio",
        "innerWidth",
        "innerHeight",
        "matchMedia",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "getComputedStyle",
        "location",
        "history",
        "fetch"
      ].map((key) => [key, globalThis[key]])
    )
  };

  window.HTMLElement.prototype.getClientRects ??= () => [];
  globalThis.document = document;
  globalThis.window = window;
  globalThis.NodeFilter = NodeFilter;
  const location = new URL("http://atria.invalid/");
  const historyCalls = [];
  globalThis.location = window.location = location;
  globalThis.history = window.history = {
    pushState(state, title, url) {
      historyCalls.push({ state, title, url });
      if (url !== undefined && url !== null) location.href = new URL(url, location).href;
    },
    replaceState(_state, _title, url) {
      if (url !== undefined && url !== null) location.href = new URL(url, location).href;
    }
  };
  globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
  globalThis.EventSource = class {
    constructor() {}
    close() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.devicePixelRatio = window.devicePixelRatio = 2;
  globalThis.innerWidth = window.innerWidth = 1440;
  globalThis.innerHeight = window.innerHeight = 900;
  // Each boot owns its polling timeouts, intervals and simulated animation
  // frames. Stop them when its page closes so they cannot read the next test's
  // workspace or keep the worker alive after its assertions finish.
  const timeouts = new Set();
  const intervals = new Set();
  const realTimers = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    const id = realTimers.setTimeout(() => {
      timeouts.delete(id);
      callback(...args);
    }, delay);
    timeouts.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeouts.delete(id);
    realTimers.clearTimeout(id);
  };
  globalThis.setInterval = (...args) => {
    const id = realTimers.setInterval(...args);
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
    realTimers.clearInterval(id);
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  const media = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  globalThis.matchMedia = window.matchMedia = media;
  // The starfield and galaxy draw into canvases linkedom cannot provide.
  const context = new Proxy({}, { get: () => () => {}, has: () => true });
  const create = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    const element = create(tag, ...rest);
    if (String(tag).toLowerCase() === "canvas") element.getContext = () => context;
    return element;
  };
  for (const canvas of document.querySelectorAll("canvas")) canvas.getContext = () => context;

  return {
    window,
    document,
    historyCalls,
    $: (selector) => document.querySelector(selector),
    async restore() {
      // In-flight visible polls must also stop scheduling their next timeout.
      window.dispatchEvent(new window.Event("pagehide"));
      // The unload handlers may flush a dirty editor through the stub server.
      // Let those promises settle while their document and fetch still exist.
      await new Promise((resolve) => realTimers.setTimeout(resolve, 0));
      for (const id of timeouts) realTimers.clearTimeout(id);
      for (const id of intervals) realTimers.clearInterval(id);
      timeouts.clear();
      intervals.clear();
      Object.assign(globalThis, realTimers);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

/**
 * The management protocol the page now needs before it reads any business data.
 *
 * Boot authorizes a local session and takes a catalog snapshot; the event
 * stream stays open without delivering anything, so the page behaves exactly as
 * a freshly connected backend would.
 */
const STUB_PROTOCOL = {
  version: "1.0",
  minClientVersion: "1.0",
  capabilities: [
    "protocol.negotiate",
    "session.authorize",
    "session.revoke",
    "operations.query",
    "commands.idempotent",
    "commands.expectedRevision",
    "events.snapshot",
    "events.stream"
  ]
};

function stubManagement(url, method, body, catalog) {
  if (url === "/api/session" && method === "POST")
    return body(
      {
        session: {
          sessionId: "session_test",
          token: "stub-session-token",
          clientName: "Formicand Web",
          protocolVersion: "1.0",
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        backend: { backendId: "backend_test", pid: 1, startedAt: "2026-01-01T00:00:00.000Z" },
        protocol: STUB_PROTOCOL
      },
      201
    );
  if (url === "/api/session")
    return body({ current: { kind: "session", sessionId: "session_test" }, sessions: [] });
  if (url === "/api/backend")
    return body({
      backendId: "backend_test",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      protocol: STUB_PROTOCOL
    });
  if (url === "/api/events/snapshot")
    return body({ ...catalog, backendId: "backend_test", cursor: 0, revisions: {} });
  if (url.startsWith("/api/events/stream"))
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) }
    };
  return undefined;
}

/** Answer the page's own requests from a small in-memory workspace. */
function stubServer({ tabs = [], tasks = [], applications = [], projects } = {}) {
  const calls = [];
  // Mutable, so a test can walk a flow that changes what the server reports.
  const state = {
    tabs: [...tabs],
    activeTabId: undefined,
    detached: false,
    created: [],
    adopted: [],
    made: []
  };
  globalThis.fetch = async (path, options = {}) => {
    const url = String(path);
    const method = options.method ?? "GET";
    calls.push(`${method} ${url.split("?")[0]}`);
    const body = (value, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => value,
      headers: { get: () => null }
    });
    const managed = stubManagement(url, method, body, {
      tasks,
      projects: projects ?? [
        {
          projectId: "p1",
          projectName: "默认项目",
          projectDirectory: "/tmp/w",
          workspaceRoot: "/tmp/w",
          tasks
        }
      ],
      workspaceRoot: "/tmp/w",
      currentWorkspaceRoot: "/tmp/w",
      model: "test-model"
    });
    if (managed !== undefined) return managed;
    if (url.startsWith("/api/tasks") && url.split("/").length === 3 && method === "GET") {
      return body({
        tasks,
        // The sidebar renders conversations grouped under a project, so a
        // fixture with no project renders no rows at all.
        projects: projects ?? [
          {
            projectId: "p1",
            projectName: "默认项目",
            projectDirectory: "/tmp/w",
            workspaceRoot: "/tmp/w",
            tasks
          }
        ],
        workspaceRoot: "/tmp/w",
        currentWorkspaceRoot: "/tmp/w",
        model: "test-model"
      });
    }
    if (url === "/api/models") return body({ current: "test-model", models: ["test-model"] });
    if (url === "/api/workbench/temporary-resources") return body({ resources: [] });
    if (url === "/api/workbench/workspaces") return body({ workspaces: ["/tmp/w"] });
    if (url === "/api/applications") return body({ applications });
    if (url === "/api/workbench/tabs" && method === "POST") {
      const sent = JSON.parse(options.body ?? "{}");
      const id =
        sent.kind === "conversation"
          ? `conversation:${sent.taskId}`
          : sent.resourceId
            ? `resource:${sent.resourceId}`
            : `window:${sent.appInstanceId}`;
      if (!state.tabs.some((tab) => tab.tabId === id)) {
        const goal = tasks.find((task) => task.taskId === (sent.bindTo ?? sent.taskId))?.goal;
        state.tabs = [
          ...state.tabs,
          sent.kind === "conversation"
            ? {
                tabId: id,
                kind: "conversation",
                taskId: sent.taskId,
                title: goal ?? sent.taskId,
                taskGoal: goal
              }
            : {
                tabId: id,
                kind: "application",
                resourceId: sent.resourceId,
                appInstanceId: sent.appInstanceId,
                appType: "text-editor",
                title: state.made.find((m) => m.resourceId === sent.resourceId)?.title ?? "文档",
                hasResource: Boolean(sent.resourceId),
                conversations: sent.bindTo ? [{ taskId: sent.bindTo, goal }] : [],
                ...(sent.bindTo ? { groupTaskId: sent.bindTo } : {})
              }
        ];
      }
      // `activate: false` is how the composer's binding control says "present
      // but not in front": binding is not navigation.
      if (sent.activate !== false) state.activeTabId = id;
      state.detached = false;
      return body({ tabs: state.tabs, activeTabId: state.activeTabId });
    }
    if (url === "/api/workbench/tabs") {
      if (method === "PATCH") {
        const sent = JSON.parse(options.body ?? "{}");
        // `null` is "no tab in front" — a state the server must keep, or the
        // next poll puts the application back over the conversation.
        state.detached = sent.tabId === null;
        state.activeTabId = sent.tabId ?? undefined;
        return body({ tabs: state.tabs, activeTabId: state.activeTabId });
      }
      const active = state.detached ? undefined : (state.activeTabId ?? state.tabs[0]?.tabId);
      return body({ tabs: state.tabs, activeTabId: active });
    }
    if (url === "/api/tasks" && method === "POST") {
      const sent = JSON.parse(options.body ?? "{}");
      const made = {
        taskId: sent.taskId ?? "task-new",
        status: "created",
        goal: sent.goal,
        projectId: sent.projectId || "p1",
        projectName: "默认项目",
        storageRoot: "/tmp/w",
        workspaceRoot: "/tmp/w"
      };
      state.created.push(made);
      tasks.push(made);
      return body(made, 201);
    }
    if (url === "/api/workbench/load-instance") {
      const sent = JSON.parse(options.body ?? "{}");
      state.adopted.push(sent);
      const existing = state.tabs.find(
        (tab) =>
          tab.kind === "application" &&
          ((sent.appInstanceId && tab.appInstanceId === sent.appInstanceId) ||
            (sent.resourceId && tab.resourceId === sent.resourceId))
      );
      if (existing) {
        existing.conversations = [
          ...(existing.conversations ?? []).filter((task) => task.taskId !== sent.taskId),
          { taskId: sent.taskId }
        ];
      } else
        state.tabs.push({
          tabId: "window:app_1",
          appInstanceId: "app_1",
          accessTaskId: "workspace",
          kind: "application",
          resourceId: "res_1",
          appType: "text-editor",
          title: "草稿.md",
          hasResource: true,
          conversations: [{ taskId: sent.taskId }],
          groupTaskId: sent.taskId
        });
      return body({
        resource: { resourceId: "res_1", title: "草稿.md", taskId: sent.taskId },
        appInstance: { appInstanceId: "app_1" },
        tabs: state.tabs
      });
    }
    if (url === "/api/workbench/open-application") {
      state.tabs = [
        {
          tabId: "window:app_1",
          kind: "application",
          workspaceRoot: "/tmp/w",
          taskId: "workspace",
          appInstanceId: "app_1",
          appType: "text-editor",
          title: "文本编辑器",
          hasResource: false
        }
      ];
      state.activeTabId = "window:app_1";
      state.detached = false;
      return body({
        appInstance: { appInstanceId: "app_1", taskId: "workspace", resourceIds: [] },
        taskId: "workspace",
        tabs: state.tabs
      });
    }
    if (url.endsWith("/app-instances/open") && method === "POST") {
      // Opening an application inside a conversation: the window belongs to that
      // conversation, not to the shared standalone workspace.
      const taskId = decodeURIComponent(url.split("/api/tasks/")[1].split("/")[0]);
      const tabId = "window:app_1";
      if (!state.tabs.some((tab) => tab.tabId === tabId)) {
        state.tabs = [
          ...state.tabs,
          {
            tabId,
            kind: "application",
            taskId,
            appInstanceId: "app_1",
            appType: "text-editor",
            title: "文本编辑器",
            hasResource: false
          }
        ];
      }
      state.activeTabId = tabId;
      state.detached = false;
      return body({ appInstance: { appInstanceId: "app_1", taskId, resourceIds: [] }, taskId }, 201);
    }
    if (
      (url.includes("/app-instances/") || url.includes("/workbench/instances/")) &&
      url.endsWith("/resources") &&
      method === "POST"
    ) {
      // Creating a document fills the window that is already open: the tab keeps
      // its id and gains a resource.
      const title = JSON.parse(options.body ?? "{}").title ?? "我的新文档.md";
      const target = state.tabs.findIndex((tab) => tab.kind === "application");
      if (target >= 0) {
        const taskId = state.tabs[target].taskId;
        state.tabs = state.tabs.map((tab, index) =>
          index === target
            ? {
                tabId: "window:app_1",
                workspaceRoot: "/tmp/w",
                appInstanceId: "app_1",
                accessTaskId: "workspace",
                kind: "application",
                resourceId: "res_1",
                appType: "text-editor",
                title,
                hasResource: true,
                conversations: taskId && taskId !== "workspace" ? [{ taskId }] : [],
                // An unclaimed document still names where it lives, so the editor
                // has a task to send its writes to.
                ...(taskId && taskId !== "workspace"
                  ? { groupTaskId: taskId }
                  : { standalone: true, taskId: "workspace" })
              }
            : tab
        );
        // The tab was rekeyed, so whatever pointed at the old id follows it.
        if (state.activeTabId === state.tabs[target]?.tabId || state.activeTabId?.startsWith("window:")) {
          state.activeTabId = "window:app_1";
        }
      }
      return body(
        {
          resource: { resourceId: "res_1", title: "我的新文档.md", path: "我的新文档.md" },
          appInstance: { appInstanceId: "app_1", resourceIds: ["res_1"] }
        },
        201
      );
    }
    if (url.endsWith("/resources") && method === "GET") {
      // The editor's 打开文档 sheet lists what the conversation references.
      return body({
        resources: state.tabs
          .filter((tab) => tab.resourceId)
          .map((tab) => ({
            resourceId: tab.resourceId,
            title: tab.title,
            appType: "text-editor",
            kind: "text/markdown",
            revision: 0
          }))
      });
    }
    if (url.endsWith("/resources") && method === "POST") {
      // A document created for the conversation itself, not into a window:
      // this is what the editor's 「打开文档 → ＋新建文档」 sheet calls.
      const sent = JSON.parse(options.body ?? "{}");
      const id = `res_${state.made.length + 2}`;
      state.made.push({ resourceId: id, title: sent.title });
      return body(
        {
          resource: { resourceId: id, title: sent.title, path: sent.title, kind: sent.kind, revision: 0 },
          snapshot: { content: sent.initialContent ?? "", revision: 0 }
        },
        201
      );
    }
    if (url.includes("/resources/") && method === "GET") {
      const asked = url.split("/resources/")[1].split("?")[0];
      const tab = state.tabs.find((entry) => entry.resourceId === asked);
      const title =
        tab?.title ??
        state.made.find((m) => m.resourceId === asked)?.title ??
        state.tabs[0]?.title ??
        "方案.md";
      return body({
        resource: { resourceId: "res_1", title, path: title, kind: "text/markdown", revision: 0 },
        snapshot: { content: `# ${title.replace(/\.[^.]+$/, "")}\n`, revision: 0 },
        operations: []
      });
    }
    if (url.includes("/api/tasks/")) {
      return body({
        task: tasks[0] ?? { taskId: "task-1", status: "created", goal: "甲" },
        workspaceRoot: "/tmp/w",
        coordination: { calls: [], pending: [], callbackPending: [] },
        events: [],
        runtimeEvents: [],
        artifacts: [],
        messages: [],
        humanRequests: [],
        statistics: null,
        runtime: { active: false, model: "test-model" },
        applications: { resources: [], instances: [], unread: [], deliverables: [], unbound: true }
      });
    }
    return body({}, 404);
  };
  return { calls, state };
}

/** Load `app.js` fresh and collect anything it throws. */
function nameDocument(page, title) {
  page.$("[data-document-name]").value = title;
  page
    .$(".editor-name-form")
    .dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
}

async function useEditorInConversation(page) {
  page.$("[data-app-collaborate]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
}

async function boot(fixture = {}) {
  const view = browserEnvironment();
  const server = stubServer(fixture);
  const failures = [];
  const onRejection = (error) => failures.push(`unhandledRejection: ${error?.message ?? error}`);
  const onError = (error) => failures.push(`uncaught: ${error?.message ?? error}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onError);
  let loadError;
  try {
    // A cache-busting query gives each test a fresh module graph, so one test's
    // module-level state cannot mask another's failure.
    await import(`../web/app.js?boot=${Math.random().toString(36).slice(2)}`);
  } catch (error) {
    loadError = error;
  }
  // Let the page's startup requests settle.
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.off("unhandledRejection", onRejection);
  process.off("uncaughtException", onError);
  return { ...view, server, failures, loadError };
}

async function waitForPage(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), message);
}

test("the page loads with no import or reference errors", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "写一份产品方案" }] });
  t.after(page.restore);
  // A broken import here takes the entire UI down — nothing on screen works,
  // which is exactly what happened when a removed export was still imported.
  assert.equal(page.loadError, undefined, `app.js must load: ${page.loadError?.message}`);
  assert.deepEqual(page.failures, [], "startup must not throw");
});

test("startup reads the task list, the model list and the global tab strip", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  for (const expected of ["GET /api/tasks", "GET /api/models", "GET /api/workbench/tabs"]) {
    assert.ok(
      page.server.calls.includes(expected),
      `startup must call ${expected}, saw ${JSON.stringify(page.server.calls)}`
    );
  }
});

test("only backend file links use the authenticated download client", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  const click = (href, name) => {
    const anchor = page.document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    page.document.body.append(anchor);
    anchor.dispatchEvent(new page.window.Event("click", { bubbles: true, cancelable: true }));
  };
  const callsOf = (fragment) => page.server.calls.filter((call) => call.includes(fragment));
  // The Markdown export shape: the bytes are already a local blob URL. Taking
  // it over would send "blob:..." to the bound backend and lose the download.
  click("blob:http://atria.invalid/markdown-export", "导出.md");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(callsOf("blob:"), [], "a page-produced blob stays local");
  click("data:text/markdown,hello", "导出.md");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(callsOf("data:text"), [], "an inline data URL stays local");
  // A backend file does need the session and the bound backend.
  const before = callsOf("/api/tasks/task-1/artifact").length;
  click("/api/tasks/task-1/artifact?path=a.md&download=1", "a.md");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    callsOf("/api/tasks/task-1/artifact").length > before,
    "a backend artifact link is fetched through the authenticated client"
  );
  assert.deepEqual(page.failures, []);
});

test("a projectless new conversation begins immediately and preserves its draft", async (t) => {
  const page = await boot({ projects: [] });
  t.after(page.restore);
  page.$("#composer-input").value = "先保留这份草稿";
  page.$("#new-conversation").click();
  assert.equal(page.$("#project-modal"), null);
  assert.equal(page.$("#composer-input").value, "先保留这份草稿");
  assert.equal(page.$("#workspace-button"), null);
  assert.equal(page.$("#workspace-label"), null);
  assert.deepEqual(page.server.state.created, []);
  assert.equal(page.window.location.hash, "");
  assert.deepEqual(
    page.historyCalls,
    [],
    "ordinary conversation navigation does not create a goal history entry"
  );
  assert.deepEqual(page.failures, []);
});

test("goal navigation owns its hash while ordinary conversation clicks keep an inactive goal route unchanged", async (t) => {
  const page = await boot();
  t.after(page.restore);
  assert.equal(page.$(".goal-workspace").hidden, true);
  page.$("#goals-nav").click();
  assert.equal(page.window.location.hash, "#goals");
  assert.equal(page.$(".goal-workspace").hidden, false);
  assert.equal(page.historyCalls.length, 1);
  page.$("#new-conversation").click();
  assert.equal(page.window.location.hash, "");
  assert.equal(page.$(".goal-workspace").hidden, true);
  assert.equal(page.historyCalls.length, 2);
  page.$("#new-conversation").click();
  assert.equal(page.historyCalls.length, 2);
});

test("a late Task creation uses its original project and preserves the later project's draft", async (t) => {
  const projects = ["a", "b"].map((id) => ({
    projectId: id,
    projectName: `项目 ${id}`,
    projectDirectory: `/tmp/${id}`,
    tasks: []
  }));
  const page = await boot({ projects });
  t.after(page.restore);
  let release, sent;
  const request = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/tasks" && options.method === "POST") {
      sent = JSON.parse(options.body);
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return request(path, options);
  };
  page.$('[data-project-create="b"]').click();
  page.$("#composer-input").value = "原有 B 项目草稿";
  page.$('[data-project-create="a"]').click();
  page.$("#composer-input").value = "发送给 A";
  page.$("#send-button").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.projectId, "a");
  assert.equal(Object.hasOwn(sent, "workspaceRoot"), false);
  page.$('[data-project-create="b"]').click();
  assert.equal(page.$("#composer-input").value, "原有 B 项目草稿");
  page.$("#composer-input").value = "B 项目未发送";
  release();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(page.$("#project-context").textContent, "项目 b");
  assert.equal(page.$("#composer-input").value, "B 项目未发送");
  assert.equal(page.$(".conversation-item.active"), null);
  assert.equal(page.server.state.created[0].projectId, "a");
  assert.deepEqual(page.failures, []);
});

test("clicking project rows restores both projects' independent new-conversation drafts", async (t) => {
  const page = await boot({
    projects: ["a", "b"].map((id) => ({
      projectId: id,
      projectName: `项目 ${id}`,
      projectDirectory: `/tmp/${id}`,
      tasks: []
    }))
  });
  t.after(page.restore);
  page.$('[data-project-create="a"]').click();
  page.$("#composer-input").value = "A 的独立草稿";
  page.$('[data-project-id="b"]').click();
  assert.equal(page.$("#composer-input").value, "");
  page.$("#composer-input").value = "B 的独立草稿";
  page.$('[data-project-id="a"]').click();
  assert.equal(page.$("#project-context").textContent, "项目 a");
  assert.equal(page.$("#composer-input").value, "A 的独立草稿");
  page.$('[data-project-id="b"]').click();
  assert.equal(page.$("#project-context").textContent, "项目 b");
  assert.equal(page.$("#composer-input").value, "B 的独立草稿");
  assert.deepEqual(page.server.state.created, []);
  assert.deepEqual(page.failures, []);
});

test("a strip spanning two tasks renders every tab, labelled by task", async (t) => {
  const tabs = [
    {
      tabId: "conversation:task-1",
      kind: "conversation",
      taskId: "task-1",
      title: "写一份产品方案",
      taskGoal: "写一份产品方案"
    },
    {
      tabId: "application:task-1:app_1",
      kind: "application",
      taskId: "task-1",
      appInstanceId: "app_1",
      appType: "text-editor",
      title: "方案.md",
      resourceId: "res_1",
      taskGoal: "写一份产品方案"
    },
    {
      tabId: "conversation:task-2",
      kind: "conversation",
      taskId: "task-2",
      title: "做一次技术调研",
      taskGoal: "做一次技术调研"
    },
    {
      tabId: "application:task-2:app_2",
      kind: "application",
      taskId: "task-2",
      appInstanceId: "app_2",
      appType: "text-editor",
      title: "笔记.md",
      resourceId: "res_2",
      taskGoal: "做一次技术调研"
    }
  ];
  const page = await boot({ tabs, tasks: [{ taskId: "task-1", status: "created", goal: "写一份产品方案" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  assert.deepEqual(page.failures, []);

  const strip = page.$("[data-tab-strip]");
  const rendered = [...strip.querySelectorAll("[data-tab]")].map((node) => node.dataset.tab);
  assert.deepEqual(
    rendered,
    tabs.map((tab) => tab.tabId),
    "all four tabs from both tasks are shown"
  );
  assert.equal(page.$("#workbench").hidden, false, "the strip must be visible once tabs exist");

  // The neighbouring conversation already names the group. Repeating that
  // title on its file looks like two conversation/document tabs for one file.
  const text = strip.textContent;
  assert.equal(
    (text.match(/写一份产品方案/g) ?? []).length,
    1,
    `the task name appears once on its conversation tab, saw: ${text}`
  );
  assert.match(
    strip.querySelector('[data-tab="application:task-1:app_1"]').getAttribute("title"),
    /关联对话：写一份产品方案/
  );
});

test("with one task open, application tabs are not prefixed with its name", async (t) => {
  const tabs = [
    { tabId: "conversation:task-1", kind: "conversation", taskId: "task-1", title: "甲", taskGoal: "甲" },
    {
      tabId: "application:task-1:app_1",
      kind: "application",
      taskId: "task-1",
      appInstanceId: "app_1",
      appType: "text-editor",
      title: "方案.md",
      resourceId: "res_1",
      taskGoal: "甲"
    }
  ];
  const page = await boot({ tabs });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  // Repeating the only open task's name on every tab is noise.
  assert.equal((page.$("[data-tab-strip]").textContent.match(/甲/g) ?? []).length, 1);
});

test("an empty strip leaves the conversation showing and says what to do", async (t) => {
  const page = await boot({ tabs: [], tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  assert.equal(page.$("#conversation-pane").hidden, false);
  assert.match(page.$("[data-tab-strip]").textContent, /没有打开的标签/);
  assert.equal(page.document.body.classList.contains("app-fullbleed"), false);
});

test("with the workbench off the page still loads and the controls stay hidden", async (t) => {
  const view = browserEnvironment();
  t.after(view.restore);
  // Every workbench route 404s, as it does with the feature flag unset.
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const url = String(path);
    calls.push(url);
    const body = (value, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => value,
      headers: { get: () => null }
    });
    const managed = stubManagement(url, method, body, {
      tasks: [{ taskId: "task-1", status: "created", goal: "甲" }],
      projects: [],
      workspaceRoot: "/tmp/w",
      currentWorkspaceRoot: "/tmp/w",
      model: "m"
    });
    if (managed !== undefined) return managed;
    if (url === "/api/tasks")
      return body({
        tasks: [{ taskId: "task-1", status: "created", goal: "甲" }],
        projects: [],
        workspaceRoot: "/tmp/w"
      });
    if (url === "/api/models") return body({ current: "m", models: ["m"] });
    if (url.startsWith("/api/workbench") || url === "/api/applications")
      return body({ error: "not found" }, 404);
    if (url.startsWith("/api/tasks/")) {
      // No `applications` field: that is what the flag being off looks like.
      return body({
        task: { taskId: "task-1", status: "created", goal: "甲" },
        workspaceRoot: "/tmp/w",
        coordination: { calls: [], pending: [], callbackPending: [] },
        events: [],
        runtimeEvents: [],
        artifacts: [],
        messages: [],
        humanRequests: [],
        statistics: null,
        runtime: { active: false }
      });
    }
    return body({}, 404);
  };
  const failures = [];
  const onRejection = (error) => failures.push(String(error?.message ?? error));
  process.on("unhandledRejection", onRejection);
  let loadError;
  try {
    await import(`../web/app.js?off=${Math.random().toString(36).slice(2)}`);
  } catch (error) {
    loadError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.off("unhandledRejection", onRejection);

  assert.equal(loadError, undefined, "a 404 on the workbench routes must not break the page");
  assert.deepEqual(failures, []);
  assert.equal(view.$("#workbench").hidden, true, "the strip stays hidden");
  assert.equal(view.$("#apps-nav").hidden, true);
  assert.equal(view.$("#app-bind-select").hidden, true);
  assert.equal(view.$("#conversation-pane").hidden, false, "the conversation is unaffected");
});

test("a streamed event is appended in place, not by copying the whole log", async (t) => {
  // The lag this pins: the SSE handler rebuilt `runtimeEvents` with
  // `[...runtimeEvents, record]` on every event. A streaming reply emits
  // thousands, so the cost grew quadratically — around ten thousand events one
  // token cost ~33ms of copying, plus the garbage each copy left behind, which
  // is the stutter felt while a reply streamed.
  //
  // Asserted on the source rather than by timing: a wall-clock threshold would
  // be flaky on a loaded machine, and the defect is the copy itself.
  const { readFileSync } = await import("node:fs");
  const source =
    readFileSync("web/assets/controllers/connection-controller.js", "utf8") +
    readFileSync("web/app.js", "utf8");
  // The stream transport is shared (fetch or EventSource), so the append lives
  // in one applyRecord used by both; the invariant is the push, not the caller.
  const start = source.indexOf("const applyRecord");
  assert.ok(start >= 0, "the stream record handler must be findable");
  const handler = source.slice(start, source.indexOf("stream.onerror"));
  assert.doesNotMatch(
    handler,
    /runtimeEvents\s*=\s*\[\s*\.\.\./,
    "per-event handling must not copy the whole event log"
  );
  assert.match(handler, /runtimeEvents\.push\(/, "it appends in place instead");
  // The merge on a detail poll may still copy: it runs once per poll, not per
  // event, and has to produce a new array to replace the old one.
  assert.match(source, /mergeRuntimeEvents\(/);
});

test("新对话 opens a tab of its own, and the first message turns it into the real one", async (t) => {
  // The bug this pins: only applications used the strip. Clicking 新对话 left
  // the previous conversation's tab highlighted while the composer wrote a new
  // one, so the row and the pane disagreed about where the person was.
  const page = await boot({
    tabs: [
      {
        tabId: "conversation:task-1",
        kind: "conversation",
        taskId: "task-1",
        title: "旧对话",
        taskGoal: "旧对话"
      }
    ],
    tasks: [{ taskId: "task-1", status: "created", goal: "旧对话" }],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  page
    .$("#project-list [data-task='task-1']")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  const strip = page.$("[data-tab-strip]");
  assert.match(strip.textContent, /新对话/, "the draft conversation is in the strip");
  assert.match(strip.textContent, /旧对话/, "and the previous conversation is still there");
  const active = page.document.querySelector("[data-tab-strip] [data-tab].active");
  assert.equal(active?.dataset.tab, "conversation:__draft__", "the draft is what is in front");
  assert.equal(page.$("#conversation-pane").hidden, false, "the conversation area is showing");
  // Returning to the same unsent conversation restores its draft. A successful
  // send clears it, while switching to another conversation uses that draft.
  page.$("#composer-input").value = "没发出去的半句话";
  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    page.$("#composer-input").value,
    "没发出去的半句话",
    "returning to the existing draft preserves unsent text"
  );
  assert.deepEqual(page.failures, []);
});

test("choosing a binding in the composer does not navigate away from the conversation", async (t) => {
  // The bug this pins: selecting an application in the binding control called
  // activate() on its tab, so the editor covered the conversation the person
  // was in the middle of typing into.
  const page = await boot({
    tabs: [
      {
        tabId: "conversation:task-1",
        kind: "conversation",
        taskId: "task-1",
        title: "写一份产品方案",
        taskGoal: "写一份产品方案"
      },
      {
        tabId: "resource:res_1",
        kind: "application",
        resourceId: "res_1",
        appType: "text-editor",
        workspaceRoot: "/tmp/w",
        title: "方案.md",
        hasResource: true,
        conversations: [{ taskId: "task-1", goal: "写一份产品方案" }],
        groupTaskId: "task-1"
      }
    ],
    tasks: [{ taskId: "task-1", status: "created", goal: "写一份产品方案" }],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  // Sit in the conversation, as a person composing a message would be.
  page
    .$("#project-list [data-task='task-1']")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(page.server.state.activeTabId, "conversation:task-1");

  page.$("#app-bind-select").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const option = page.$("#app-bind-menu [data-bind-instance='res_1']");
  assert.ok(option, "the conversation's own window is offered");
  option.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    page.server.state.activeTabId,
    "conversation:task-1",
    "binding must not move the strip off the conversation"
  );
  assert.equal(page.$("#conversation-pane").hidden, false, "the conversation stays visible");
  assert.deepEqual(page.failures, []);
});

test("a temporary document saved to a project starts collaboration in that project without adopting its temporary root", async (t) => {
  const chosen = {
    projectId: "chosen",
    projectName: "Chosen",
    projectDirectory: "/tmp/chosen",
    workspaceRoot: "/tmp/chosen",
    tasks: []
  };
  const page = await boot({
    tasks: [],
    projects: [chosen],
    tabs: [
      {
        tabId: "window:app_saved",
        kind: "application",
        appInstanceId: "app_saved",
        appType: "text-editor",
        title: "Saved document",
        hasResource: false,
        workspaceRoot: "/tmp/temporary-managed",
        accessTaskId: "temporary-holding",
        project: chosen,
        standalone: true,
        conversations: [],
        loadedConversations: []
      }
    ],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  await useEditorInConversation(page);
  await waitForPage(() => page.server.state.created.length > 0, "collaboration creates a conversation");
  assert.equal(page.server.state.created[0].projectId, chosen.projectId);
  assert.equal(
    page.server.calls.includes("POST /api/projects"),
    false,
    "physical temporary roots never become projects"
  );
  assert.equal(page.server.state.adopted[0].appInstanceId, "app_saved");
  assert.deepEqual(page.failures, []);
});
