import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { createMainSessionsController } from "../web/assets/controllers/main-sessions.js";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";

const run = promisify(execFile);

/**
 * The session consumers: the production controller, the production composer
 * drafts and a real Pi process talking to a local fake model.
 *
 * The fake model is the observation point for "input entered the selected
 * session": what each process was actually asked is the only claim that
 * matters, so a leaked draft or a late page load shows up as the wrong text in
 * the wrong conversation.
 */
async function provider(t, { hold = () => false } = {}) {
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      const raw = await readFixtureRequestBody(request);
      const body = JSON.parse(raw);
      requests.push(body);
      if (hold()) return new Promise(() => {});
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", { text: `第 ${requests.length} 轮完成` }));
    } catch (error) {
      failures.push(error.stack ?? error.message);
      response.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests, failures };
}

function client(dashboard) {
  return async (path, body, method) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

const userText = (body) =>
  (body.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    )
    .join("\n");

async function settle(request, taskId, status) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (detail.status === 200 && !detail.body.runtime.active) {
      assert.equal(detail.body.task.status, status, JSON.stringify(detail.body.task));
      return detail.body;
    }
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle to ${status}`);
}

async function createProject(request, dashboard, name) {
  const directory = join(dashboard.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const created = await request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project;
}

const waitFor = async (check, message, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
};

/** Processes this test owns: their argv names the disposable data root. */
async function ownedProcesses(root) {
  const { stdout } = await run("ps", ["-ax", "-o", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => line.trim())
    .filter(Boolean);
}

test(
  "the session view lists, creates, switches and continues one project at a time",
  { timeout: 120_000 },
  async (t) => {
    const local = await provider(t);
    const dashboard = await startDashboard({
      modelEndpoint: local.base,
      model: "fixture-model",
      defaultProject: false
    });
    t.after(() => dashboard.stop());
    const request = client(dashboard);
    const a = await createProject(request, dashboard, "a");
    const b = await createProject(request, dashboard, "b");

    const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    });
    const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
    globalThis.window = window;
    globalThis.document = document;
    globalThis.CSS = { escape: (value) => value };
    window.HTMLElement.prototype.getClientRects ??= () => [];
    const records = new Map();
    const storage = {
      get length() {
        return records.size;
      },
      key: (index) => [...records.keys()][index] ?? null,
      getItem: (key) => records.get(key),
      setItem: (key, value) => records.set(key, value),
      removeItem: (key) => records.delete(key)
    };
    let attachments = [];
    const input = { value: "", addEventListener() {} };
    const composer = createComposerSession({
      input,
      storage,
      getAttachments: () => attachments,
      setAttachments: (files) => {
        attachments = files;
      }
    });
    composer.activate(null);
    composer.setBackend("test-backend");
    composer.activate(null, { projectId: a.projectId });

    const state = {
      projects: [
        { ...a, tasks: [] },
        { ...b, tasks: [] }
      ],
      tasks: [],
      selectedProjectId: a.projectId,
      selected: null,
      api: (path, options) =>
        fetch(`${dashboard.base}${path}`, {
          method: options?.method ?? (options?.body === undefined ? "GET" : "POST"),
          headers: options?.headers ?? { "content-type": "application/json" },
          ...(options?.body === undefined ? {} : { body: options.body })
        }).then(async (response) => {
          const body = await response.json();
          if (!response.ok)
            throw Object.assign(new Error(body.error ?? "请求失败"), { status: response.status });
          return body;
        })
    };
    const view = {
      window,
      document,
      controllers: createMainSessionsController({
        api: state.api,
        state,
        openSession: ({ taskId }) => {
          state.selected = taskId;
          composer.activate(taskId);
        }
      })
    };
    const $ = (selector) => document.querySelector(selector);

    // List the selected project: an empty project has no sessions.
    view.controllers.open(a.projectId);
    await waitFor(
      () => /还没有会话/.test($("[data-sessions]").textContent),
      "project A sessions did not load"
    );
    assert.equal($("[data-project]").value, a.projectId);

    // Create a session in A: it becomes a real Task in A and opens for input.
    const form = $("[data-create]");
    form.querySelector('[name="title"]').value = "A 的登录会话";
    form.dispatchEvent(new view.window.Event("submit", { cancelable: true }));
    await waitFor(
      () => /A 的登录会话/.test($("[data-sessions]").textContent),
      "created session was not listed"
    );
    const aSession = state.selected;
    assert.ok(aSession, "creating a session opens it");
    const aList = await request("/api/tasks");
    assert.equal(
      aList.body.tasks.find((task) => task.taskId === aSession).projectId,
      a.projectId,
      "the session's history container belongs to project A"
    );
    assert.equal(form.querySelector('[name="title"]').value, "");

    // Creating a session opens its conversation; come back to the list.
    view.controllers.open(a.projectId);
    await waitFor(() => /A 的登录会话/.test($("[data-sessions]").textContent), "A sessions did not reopen");

    // A draft and its attachments belong to the selected session.
    input.value = "A 的草稿";
    attachments = [{ name: "a.txt", text: "A 附件" }];
    composer.save();

    // Switching the session view's project reads only that project and leaves
    // the composer's target and draft alone.
    const select = $("[data-project]");
    select.children[0].removeAttribute("selected");
    select.children[1].setAttribute("selected", "");
    select.dispatchEvent(new view.window.Event("change"));
    await waitFor(
      () => /还没有会话/.test($("[data-sessions]").textContent),
      "project B sessions did not load"
    );
    assert.equal(input.value, "A 的草稿", "switching the list does not move the draft");
    assert.equal(attachments[0].name, "a.txt");

    // Create B's session; input now belongs to B and A's draft is put aside.
    form.querySelector('[name="title"]').value = "B 的报表会话";
    form.dispatchEvent(new view.window.Event("submit", { cancelable: true }));
    await waitFor(() => /B 的报表会话/.test($("[data-sessions]").textContent), "B session was not listed");
    const bSession = state.selected;
    assert.notEqual(bSession, aSession);
    assert.equal(input.value, "");
    assert.deepEqual(attachments, []);
    input.value = "B 的草稿";
    composer.save();
    view.controllers.open(b.projectId);
    await waitFor(() => /B 的报表会话/.test($("[data-sessions]").textContent), "B sessions did not reopen");

    // Continue A: the list goes back to A and its draft and attachments return.
    select.children[1].removeAttribute("selected");
    select.children[0].setAttribute("selected", "");
    select.dispatchEvent(new view.window.Event("change"));
    await waitFor(() => /A 的登录会话/.test($("[data-sessions]").textContent), "A sessions did not reload");
    assert.doesNotMatch($("[data-sessions]").textContent, /B 的报表会话/);
    $("[data-session]").click();
    assert.equal(state.selected, aSession);
    assert.equal(input.value, "A 的草稿");
    assert.equal(attachments[0].name, "a.txt");

    // Input goes to the selected project's session only.
    const aRun = await request(`/api/tasks/${encodeURIComponent(state.selected)}/run`, {
      prompt: "请处理 A 的登录问题。",
      mainSessionId: $("[data-session]").dataset.session
    });
    assert.equal(aRun.status, 202, JSON.stringify(aRun.body));

    // A late A response must not take the page back after the person moved to B.
    view.controllers.open(b.projectId);
    await waitFor(() => /B 的报表会话/.test($("[data-sessions]").textContent), "B sessions did not reload");
    $("[data-session]").click();
    assert.equal(state.selected, bSession);
    assert.equal(input.value, "B 的草稿");
    await settle(request, aSession, "completed");
    assert.equal(state.selected, bSession, "A's late completion left B selected");
    assert.equal(input.value, "B 的草稿");
    assert.equal(local.requests.length, 1);
    assert.match(userText(local.requests[0]), /请处理 A 的登录问题/);
    assert.doesNotMatch(userText(local.requests[0]), /B 的草稿/);

    // Continuing B emits B's words and not A's.
    const bRun = await request(`/api/tasks/${encodeURIComponent(state.selected)}/run`, {
      prompt: "请处理 B 的报表问题。",
      mainSessionId: $("[data-session]").dataset.session
    });
    assert.equal(bRun.status, 202, JSON.stringify(bRun.body));
    await settle(request, bSession, "completed");
    assert.equal(local.requests.length, 2);
    assert.match(userText(local.requests[1]), /请处理 B 的报表问题/);
    assert.doesNotMatch(userText(local.requests[1]), /请处理 A 的登录问题/);

    // Two sessions, two transcripts: neither contains the other's turn.
    const aTranscript = await readdir(join(dashboard.workspaceRoot, aSession, "sessions", "main", "pi"));
    const bTranscript = await readdir(join(dashboard.workspaceRoot, bSession, "sessions", "main", "pi"));
    assert.equal(aTranscript.length, 1);
    assert.equal(bTranscript.length, 1);
    assert.notEqual(aTranscript[0], bTranscript[0]);
    const aText = await readFile(
      join(dashboard.workspaceRoot, aSession, "sessions", "main", "pi", aTranscript[0]),
      "utf8"
    );
    const bText = await readFile(
      join(dashboard.workspaceRoot, bSession, "sessions", "main", "pi", bTranscript[0]),
      "utf8"
    );
    assert.match(aText, /请处理 A 的登录问题/);
    assert.doesNotMatch(aText, /请处理 B 的报表问题/);
    assert.match(bText, /请处理 B 的报表问题/);
    assert.doesNotMatch(bText, /请处理 A 的登录问题/);
    assert.deepEqual(local.failures, []);
  }
);

test("a late session list or creation never replaces the project on the page", async () => {
  const deferred = [];
  const api = (path) =>
    new Promise((resolve) => {
      deferred.push({ path, resolve });
    });
  const state = {
    projects: [
      { projectId: "a", projectName: "项目 A", projectDirectory: "/tmp/a", tasks: [] },
      { projectId: "b", projectName: "项目 B", projectDirectory: "/tmp/b", tasks: [] }
    ],
    selectedProjectId: "a",
    selected: null
  };
  const opened = [];
  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const controller = createMainSessionsController({
    api,
    state,
    openSession: ({ taskId }) => opened.push(taskId)
  });
  const $ = (selector) => document.querySelector(selector);
  try {
    // Opening A leaves its list in flight; switching to B is what the page shows.
    controller.open("a");
    const aLoad = deferred.shift();
    assert.match(aLoad.path, /\/api\/projects\/a\/main-sessions$/);
    const select = $("[data-project]");
    select.children[0].removeAttribute("selected");
    select.children[1].setAttribute("selected", "");
    select.dispatchEvent(new window.Event("change"));
    const bLoad = deferred.shift();
    assert.match(bLoad.path, /\/api\/projects\/b\/main-sessions$/);
    bLoad.resolve({
      projectId: "b",
      sessions: [
        {
          sessionId: "session_b",
          projectId: "b",
          taskId: "task-b",
          title: "B 会话",
          entryKind: "internal",
          kind: "regular",
          local: true
        }
      ]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match($("[data-sessions]").textContent, /B 会话/);

    // A's late answer arrives now and is dropped: the page stays on B.
    aLoad.resolve({
      projectId: "a",
      sessions: [
        {
          sessionId: "session_a",
          projectId: "a",
          taskId: "task-a",
          title: "A 会话",
          entryKind: "internal",
          kind: "regular",
          local: true
        }
      ]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch($("[data-sessions]").textContent, /A 会话/);

    // A late creation for A after the person moved to B cannot open its Task.
    select.children[1].removeAttribute("selected");
    select.children[0].setAttribute("selected", "");
    select.dispatchEvent(new window.Event("change"));
    const aReload = deferred.shift();
    assert.match(aReload.path, /\/api\/projects\/a\/main-sessions$/);
    const form = $("[data-create]");
    form.querySelector('[name="title"]').value = "A 的新会话";
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    const aCreate = deferred.shift();
    assert.match(aCreate.path, /\/api\/projects\/a\/main-sessions$/);
    select.children[0].removeAttribute("selected");
    select.children[1].setAttribute("selected", "");
    select.dispatchEvent(new window.Event("change"));
    const bReload = deferred.shift();
    assert.match(bReload.path, /\/api\/projects\/b\/main-sessions$/);
    aCreate.resolve({
      session: { sessionId: "session_new", projectId: "a", taskId: "task-new", title: "A 的新会话" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(opened, [], "a late creation does not move the page");
    bReload.resolve({ projectId: "b", sessions: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match($("[data-sessions]").textContent, /还没有会话/);
    // The earlier A reload is also stale; it cannot bring A back either.
    aReload.resolve({
      projectId: "a",
      sessions: [{ sessionId: "session_a", projectId: "a", taskId: "task-a", title: "A 会话", local: true }]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch($("[data-sessions]").textContent, /A 会话/);
  } finally {
    controller.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("cancel and an abnormal exit leave no Main process this run owns", { timeout: 120_000 }, async (t) => {
  let holding = false;
  const local = await provider(t, { hold: () => holding });
  const dashboard = await startDashboard({
    modelEndpoint: local.base,
    model: "fixture-model",
    defaultProject: false
  });
  const request = client(dashboard);
  const project = await createProject(request, dashboard, "process");
  const created = await request(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`, {
    action: "create",
    title: "进程回收"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const session = created.body.session;

  // Cancel while the model call is still open: the Run ends and its process goes.
  holding = true;
  const started = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    prompt: "这一轮会被取消。",
    mainSessionId: session.sessionId
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await waitFor(() => local.requests.length === 1, "the Main process never reached the model");
  assert.ok((await ownedProcesses(dashboard.root)).length > 0, "the Main process is running before cancel");
  const cancelled = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/action`, {
    action: "cancel"
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, "cancelled");
  await waitFor(
    async () => (await ownedProcesses(dashboard.root)).length === 0,
    "a cancelled Main process stayed alive"
  );
  const listed = await request(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`);
  assert.equal(listed.body.sessions[0].runs[0].state, "cancelled");

  // An abnormal backend exit must not orphan the process either.
  const again = await request(`/api/tasks/${encodeURIComponent(session.taskId)}/run`, {
    prompt: "这一轮在退出时中止。",
    mainSessionId: session.sessionId
  });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  await waitFor(() => local.requests.length === 2, "the restarted Main never reached the model");
  assert.ok((await ownedProcesses(dashboard.root)).length > 0, "the Main process is running before shutdown");
  await dashboard.stop();
  await waitFor(
    async () => (await ownedProcesses(dashboard.root)).length === 0,
    "the backend exit left its Main process running"
  );
  assert.deepEqual(local.failures, []);
});
