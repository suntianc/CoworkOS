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
function stubServer({ tasks = [], projects } = {}) {
  const calls = [];
  // Mutable, so a test can walk a flow that changes what the server reports.
  const state = { created: [] };
  const catalog = (list = tasks, projectList = projects) => ({
    tasks: list,
    // The sidebar renders conversations grouped under a project, so a fixture
    // with no project renders no rows at all.
    projects: projectList ?? [
      {
        projectId: "p1",
        projectName: "默认项目",
        projectDirectory: "/tmp/w",
        workspaceRoot: "/tmp/w",
        tasks: list
      }
    ],
    workspaceRoot: "/tmp/w",
    currentWorkspaceRoot: "/tmp/w",
    model: "test-model"
  });
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
    const managed = stubManagement(url, method, body, catalog());
    if (managed !== undefined) return managed;
    if (url.startsWith("/api/tasks") && url.split("/").length === 3 && method === "GET")
      return body(catalog());
    if (url === "/api/models") return body({ current: "test-model", models: ["test-model"] });
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
        runtime: { active: false, model: "test-model" }
      });
    }
    return body({}, 404);
  };
  return { calls, state };
}

/** Load `app.js` fresh and collect anything it throws. */
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

test("startup reads the task list and the model list", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  for (const expected of ["GET /api/tasks", "GET /api/models"]) {
    assert.ok(
      page.server.calls.includes(expected),
      `startup must call ${expected}, saw ${JSON.stringify(page.server.calls)}`
    );
  }
});

test("the work page offers no application or workbench surface", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  for (const selector of ["#workbench", "[data-tab-strip]", "#app-bind-select", "[data-composer-context]"])
    assert.equal(page.$(selector), null, `${selector} must not exist`);
  assert.ok(page.$("#conversation-pane"), "the conversation stays the work page");
  assert.deepEqual(page.failures, []);
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
