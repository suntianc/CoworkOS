import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { startProjectDataDashboard } from "./p3-storage-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectBoardController } from "../web/assets/controllers/project-board.js";
import { createProjectLedgerTool } from "../dist/src/runtime/project-ledger-tool.js";

const project = (id, name) => ({
  projectId: id,
  projectName: name,
  projectDirectory: `/tmp/${id}`,
  tasks: []
});

const entry = (overrides = {}) => ({
  projectId: "project_a",
  boardId: "board_a",
  requirementId: "requirement_a",
  title: "登录记住设备",
  content: "同一台设备 30 天内不再验证。",
  entryKind: "external",
  source: { kind: "external", reference: "控制入口" },
  state: "pending",
  revision: 1,
  backendId: "backend_authority",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let index = 0; index < 4; index += 1) await tick();
};

function browser(t) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  return { window, document, restore };
}

/** A stub transport whose board facts are scoped per backend and project. */
function boardView(t, { boards = {}, backendId: initialBackend = "backend_one" } = {}) {
  const { window, document, restore } = browser(t);
  const calls = [];
  const toasts = [];
  let backendId = initialBackend;
  let offline = false;
  let failure;
  const state = {
    projects: [project("project_a", "项目 A"), project("project_b", "项目 B")],
    selectedProjectId: "project_a",
    selected: null
  };
  const key = (projectId) => `${backendId}\u0000${projectId}`;
  for (const [name, list] of Object.entries(boards)) {
    if (!name.includes("\u0000")) boards[`${initialBackend}\u0000${name}`] = list;
  }
  const find = (projectId, boardId) =>
    (boards[key(projectId)] ?? []).find((item) => item.boardId === boardId);
  const save = (projectId, next) => {
    boards[key(projectId)] = (boards[key(projectId)] ?? []).map((item) =>
      item.boardId === next.boardId ? next : item
    );
    return next;
  };
  const api = async (path, options) => {
    calls.push({ path, options });
    if (offline) throw new Error("无法连接共享项目数据服务 http://127.0.0.1:1：连接失败");
    const url = new URL(path, "http://local.invalid");
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/board(?:\/([^/]+))?$/);
    assert.ok(match, `unexpected board call ${path}`);
    const projectId = decodeURIComponent(match[1]);
    if (options?.method === "POST") {
      const body = JSON.parse(options.body);
      if (failure) {
        const next = failure;
        failure = undefined;
        const error = new Error(next.message);
        error.status = next.status;
        error.code = next.code;
        throw error;
      }
      if (body.action === "publish") {
        const created = entry({
          projectId,
          boardId: `board_${calls.length}`,
          requirementId: `requirement_${calls.length}`,
          title: body.title,
          content: body.content,
          source: body.source,
          state: "pending",
          revision: 1
        });
        boards[key(projectId)] = [created, ...(boards[key(projectId)] ?? [])];
        return { entry: created };
      }
      const current = find(projectId, body.boardId);
      assert.ok(current, "the target board item exists");
      if (current.revision !== body.expectedRevision) {
        const error = new Error("看板需求已更新，请基于最新版本重试");
        error.status = 409;
        error.code = "revision_conflict";
        throw error;
      }
      if (body.action === "claim") {
        if (current.state !== "pending") {
          const error = new Error("看板需求已被认领或暂停，不能重复认领");
          error.status = 409;
          error.code = "board_state_conflict";
          throw error;
        }
        return {
          entry: save(projectId, {
            ...current,
            state: "claimed",
            revision: current.revision + 1,
            assignment: { kind: "user", actorId: "host", assignedAt: "2026-01-02T00:00:00.000Z" }
          })
        };
      }
      if (body.action === "pause")
        return { entry: save(projectId, { ...current, state: "paused", revision: current.revision + 1 }) };
      if (body.action === "release")
        return {
          entry: save(projectId, {
            ...current,
            state: "pending",
            revision: current.revision + 1,
            assignment: undefined
          })
        };
      if (body.action === "cancel")
        return {
          entry: save(projectId, { ...current, state: "cancelled", revision: current.revision + 1 })
        };
    }
    if (match[2]) return { entry: find(projectId, decodeURIComponent(match[2])), events: [] };
    return { projectId, entries: boards[key(projectId)] ?? [] };
  };
  const controller = createProjectBoardController({
    api,
    state,
    getBackend: () => backendId,
    showToast: (message) => toasts.push(message)
  });
  t.after(() => {
    controller.close();
    restore();
  });
  const $ = (selector) => document.querySelector(selector);
  return {
    window,
    document,
    controller,
    calls,
    toasts,
    state,
    boards,
    $,
    setBackend(value) {
      backendId = value;
    },
    setOffline(value) {
      offline = value;
    },
    failNext(value) {
      failure = value;
    }
  };
}

test("board view shows unclaimed and claimed demands and updates only on a user claim", async (t) => {
  const view = boardView(t, {
    boards: {
      project_a: [
        entry({ boardId: "board_pending", requirementId: "requirement_pending", title: "导出月度报表" }),
        entry({
          boardId: "board_claimed",
          requirementId: "requirement_claimed",
          title: "接入新的消息渠道",
          state: "claimed",
          revision: 2,
          assignment: {
            kind: "main",
            actorId: "backend_one:host",
            handler: { backendId: "backend_one", projectId: "project_a", taskId: "task-main" },
            assignedAt: "2026-01-02T00:00:00.000Z"
          }
        })
      ]
    }
  });
  assert.ok(view.$("#board-nav"), "the sidebar offers the board view");
  view.controller.open();
  await settle();
  const list = view.$("[data-list]").textContent;
  assert.match(list, /导出月度报表/);
  assert.match(list, /接入新的消息渠道/);
  assert.match(list, /待认领/);
  assert.match(list, /已认领/);
  assert.match(list, /Main · task-main/, "a claimed demand shows its handling Main");
  assert.doesNotMatch(list, /内部需求/, "internal ledger needs never render on the board");

  // Selecting shows the demand and its ownership; a user claim is the only
  // action that changes the board.
  view.$("[data-list] button").click();
  await settle();
  assert.match(view.$("[data-detail]").textContent, /尚未认领/);
  view.$('[data-board-action="claim"]').click();
  await settle();
  const write = view.calls.filter((call) => call.options?.method === "POST").at(-1);
  const body = JSON.parse(write.options.body);
  assert.equal(body.action, "claim");
  assert.equal(body.boardId, "board_pending");
  assert.equal(body.expectedRevision, 1);
  assert.ok(body.requestId);
  assert.match(view.$("[data-detail]").textContent, /归属：用户/);
  assert.match(view.$("[data-list]").textContent, /已认领/);
  assert.equal(view.toasts.at(-1), "已认领");
  assert.equal(
    view.calls.filter(
      (call) => call.options?.method === "POST" && JSON.parse(call.options.body).action === "create"
    ).length,
    0,
    "the board never creates a ledger-only requirement"
  );
});

test("a project or backend switch restores that selection and publish draft", async (t) => {
  const view = boardView(t, {
    boards: {
      project_a: [entry({ boardId: "board_a1", requirementId: "requirement_a1", title: "A 的第一个需求" })],
      project_b: [
        entry({
          projectId: "project_b",
          boardId: "board_b1",
          requirementId: "requirement_b1",
          title: "B 的需求"
        })
      ]
    }
  });
  view.controller.open("project_a");
  await settle();
  view.$("[data-list] button").click();
  await settle();
  const publish = view.$("[data-publish]");
  publish.querySelector('[name="title"]').value = "A 的发布草稿";
  publish.querySelector('[name="content"]').value = "A 的内容";
  publish.querySelector('[name="reference"]').value = "渠道 A";
  publish.dispatchEvent(new view.window.Event("input"));
  assert.equal(view.$("[data-list] button").getAttribute("aria-current"), "true");

  // Switching project shows only B's demand and B's (empty) draft.
  const select = view.$("[data-project]");
  select.children[0].removeAttribute("selected");
  select.children[1].setAttribute("selected", "");
  select.dispatchEvent(new view.window.Event("change"));
  await settle();
  assert.match(view.$("[data-list]").textContent, /B 的需求/);
  assert.doesNotMatch(view.$("[data-list]").textContent, /A 的第一个需求/);
  assert.equal(view.$('[name="title"]').value, "");
  publish.querySelector('[name="title"]').value = "B 的发布草稿";
  publish.dispatchEvent(new view.window.Event("input"));

  // Back to A: the selected demand and the draft belong to A again.
  select.children[1].removeAttribute("selected");
  select.children[0].setAttribute("selected", "");
  select.dispatchEvent(new view.window.Event("change"));
  await settle();
  assert.equal(view.$('[name="title"]').value, "A 的发布草稿");
  assert.equal(view.$('[name="content"]').value, "A 的内容");
  assert.equal(view.$('[name="reference"]').value, "渠道 A");
  assert.equal(view.$("[data-list] button").getAttribute("aria-current"), "true");
  assert.match(view.$("[data-detail]").textContent, /A 的第一个需求/);

  // A backend switch loads that backend's board; switching back restores the
  // previous backend's selection and draft instead of leaking them.
  view.boards["backend_two\u0000project_a"] = [
    entry({ boardId: "board_other", requirementId: "requirement_other", title: "另一后端的看板" })
  ];
  view.setBackend("backend_two");
  view.controller.render();
  await settle();
  assert.match(view.$("[data-list]").textContent, /另一后端的看板/);
  assert.doesNotMatch(view.$("[data-list]").textContent, /A 的第一个需求/);
  assert.equal(view.$('[name="title"]').value, "", "the draft belongs to the backend it was typed in");
  view.setBackend("backend_one");
  view.controller.render();
  await settle();
  assert.match(view.$("[data-list]").textContent, /A 的第一个需求/);
  assert.equal(view.$('[name="title"]').value, "A 的发布草稿");
});

test("a stale revision and an offline backend keep the selection and draft", async (t) => {
  const view = boardView(t, {
    boards: {
      project_a: [entry({ boardId: "board_a1", requirementId: "requirement_a1", title: "导出月度报表" })]
    }
  });
  view.controller.open("project_a");
  await settle();
  view.$("[data-list] button").click();
  await settle();
  const publish = view.$("[data-publish]");
  publish.querySelector('[name="title"]').value = "未发布的看板草稿";
  publish.querySelector('[name="content"]').value = "草稿内容";
  publish.dispatchEvent(new view.window.Event("input"));

  // A stale page loses the claim; the item, its draft and the visible error stay.
  view.failNext({ status: 409, message: "看板需求已更新，请基于最新版本重试" });
  view.$('[data-board-action="claim"]').click();
  await settle();
  assert.match(view.$("[data-error]").textContent, /看板需求已更新/);
  assert.equal(view.$("[data-error]").hidden, false);
  assert.equal(view.$("[data-list] button").getAttribute("aria-current"), "true");
  assert.match(view.$("[data-detail]").textContent, /导出月度报表/);
  assert.equal(view.$('[name="title"]').value, "未发布的看板草稿");

  // Offline is reported and does not imply success or move the draft.
  view.setOffline(true);
  view.$('[data-board-action="claim"]').click();
  await settle();
  assert.match(view.$("[data-error]").textContent, /无法连接共享项目数据服务/);
  assert.equal(view.$("[data-list] button").getAttribute("aria-current"), "true");
  assert.equal(view.$('[name="title"]').value, "未发布的看板草稿");
  assert.equal(view.$("[data-list]").textContent.includes("已认领"), false);

  // The publish retry keeps one request identity, so a lost response cannot
  // publish the same demand twice.
  view.setOffline(false);
  view.failNext({ status: 503, message: "共享项目数据服务暂时不可用" });
  publish.dispatchEvent(new view.window.Event("submit", { cancelable: true }));
  await settle();
  const firstPublish = JSON.parse(
    view.calls.filter((call) => JSON.parse(call.options?.body ?? "{}").action === "publish").at(-1).options
      .body
  );
  publish.dispatchEvent(new view.window.Event("submit", { cancelable: true }));
  await settle();
  const secondPublish = JSON.parse(
    view.calls.filter((call) => JSON.parse(call.options?.body ?? "{}").action === "publish").at(-1).options
      .body
  );
  assert.equal(firstPublish.requestId, secondPublish.requestId);
  assert.equal(view.$('[name="title"]').value, "");
  assert.equal(view.toasts.at(-1), "需求已发布");
});

test("the production board reads and claims through the real HTTP backend", async (t) => {
  const dashboard = await startProjectDataDashboard(t, "sqlite");
  const directory = join(dashboard.root, "board-project");
  await mkdir(directory, { recursive: true });
  const created = await dashboard.request("/api/projects", {
    projectName: "看板项目",
    projectDirectory: directory
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectId = created.body.project.projectId;
  const external = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/board`, {
    action: "publish",
    requestId: "publish-production",
    title: "生产看板需求",
    content: "通过真实 HTTP 发布。",
    source: { kind: "external", reference: "控制入口" }
  });
  assert.equal(external.status, 201, JSON.stringify(external.body));
  const internal = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/ledger`, {
    action: "create",
    title: "内部需求",
    content: "内部需求只进台账。",
    source: { kind: "internal" }
  });
  assert.equal(internal.status, 201, JSON.stringify(internal.body));

  const { window, document, restore } = browser(t);
  const state = {
    projects: [
      {
        projectId,
        projectName: "看板项目",
        projectDirectory: directory,
        tasks: []
      }
    ],
    selectedProjectId: projectId,
    selected: null
  };
  const api = async (path, options = {}) => {
    const response = await fetch(`${dashboard.base}${path}`, options);
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error);
      error.status = response.status;
      error.code = body.code;
      throw error;
    }
    return body;
  };
  const controller = createProjectBoardController({
    api,
    state,
    getBackend: () => "backend_authority",
    showToast: () => {}
  });
  t.after(() => {
    controller.close();
    restore();
  });
  controller.open(projectId);
  await settle();
  const list = document.querySelector("[data-list]").textContent;
  assert.match(list, /生产看板需求/);
  assert.doesNotMatch(list, /内部需求/, "an internal requirement creates no board item");
  document.querySelector("[data-list] button").click();
  await settle();
  document.querySelector('[data-board-action="claim"]').click();
  await settle();
  assert.match(document.querySelector("[data-detail]").textContent, /归属：用户/);
  const after = await dashboard.request(
    `/api/projects/${encodeURIComponent(projectId)}/board`,
    undefined,
    "GET"
  );
  const persisted = after.body.entries.find((item) => item.title === "生产看板需求");
  assert.equal(persisted.state, "claimed");
  assert.equal(persisted.assignment.kind, "user");
  assert.equal(after.body.entries.length, 1, "the internal need stayed out of the board");

  // The Main tool reads the same board and claims through its Task binding.
  const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
  assert.ok(instance.value?.token);
  const task = await dashboard.request("/api/tasks", {
    taskId: "task-board-main",
    goal: "处理看板需求",
    projectId
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const second = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/board`, {
    action: "publish",
    requestId: "publish-main",
    title: "Main 认领的需求",
    content: "由当前会话的处理 Main 认领。",
    source: { kind: "external", reference: "控制入口" }
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const tool = createProjectLedgerTool({
    dashboardUrl: dashboard.base,
    taskId: "task-board-main",
    token: instance.value.token
  });
  const board = await tool.execute({ action: "board" });
  assert.equal(board.entries.length, 2);
  const claimed = await tool.execute({
    action: "claim_board",
    boardId: second.body.entry.boardId,
    expectedRevision: 1
  });
  assert.equal(claimed.entry.state, "claimed");
  assert.equal(claimed.entry.assignment.kind, "main");
  assert.deepEqual(claimed.entry.assignment.handler, {
    backendId: instance.value.backendId,
    projectId,
    taskId: "task-board-main"
  });
});
