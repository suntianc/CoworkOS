import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { projectDataConfig } from "./p3-storage-fixture.mjs";
import { createProjectLedgerController } from "../web/assets/controllers/project-ledger.js";
import { createProjectLedgerTool } from "../dist/src/runtime/project-ledger-tool.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";

const project = (id, name) => ({
  projectId: id,
  projectName: name,
  projectDirectory: `/tmp/${id}`,
  tasks: []
});

const summary = (overrides) => ({
  projectId: "project_a",
  requirementId: "requirement_a",
  title: "登录记住设备",
  content: "同一台设备 30 天内不再验证。",
  source: { kind: "internal", reference: "会话" },
  status: "open",
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  decisions: [],
  references: [],
  revisions: [],
  ...overrides
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The ledger view with a stubbed transport; no page boot and no real network. */
function ledgerView(t) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const calls = [];
  const toasts = [];
  const requirements = {
    project_a: [
      summary({
        decisions: [
          {
            decisionId: "decision_a",
            text: "使用设备令牌",
            effective: true,
            source: { kind: "internal" },
            atRevision: 1,
            createdAt: "2026-01-02T00:00:00.000Z"
          }
        ]
      })
    ],
    project_b: [summary({ projectId: "project_b", requirementId: "requirement_b", title: "报表导出" })]
  };
  const state = {
    projects: [project("project_a", "项目 A"), project("project_b", "项目 B")],
    selectedProjectId: "project_a",
    selected: null
  };
  const controller = createProjectLedgerController({
    api: async (path, options) => {
      calls.push({ path, options });
      const url = new URL(path, "http://local.invalid");
      const projectId = decodeURIComponent(url.pathname.split("/")[3]);
      if (options?.method === "POST") {
        const body = JSON.parse(options.body);
        if (body.action === "create")
          return {
            requirement: summary({
              projectId,
              requirementId: "requirement_new",
              title: body.title,
              content: body.content,
              source: body.source
            })
          };
        if (body.action === "set_decision_effective")
          return {
            requirement: summary({
              projectId,
              revision: 1,
              decisions: [{ ...requirements.project_a[0].decisions[0], effective: body.effective }]
            })
          };
      }
      const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/ledger\/([^/]+)$/);
      if (match)
        return { requirement: summary({ projectId, decisions: requirements.project_a[0].decisions }) };
      const text = url.searchParams.get("q") ?? "";
      return {
        projectId,
        requirements: (requirements[projectId] ?? []).filter(
          (entry) => !text || entry.title.includes(text) || entry.content.includes(text)
        )
      };
    },
    state,
    showToast: (message) => toasts.push(message)
  });
  t.after(() => {
    controller.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const $ = (selector) => document.querySelector(selector);
  return { window, document, controller, calls, toasts, state, $ };
}

test("ledger view creates and queries requirements and switches projects", async (t) => {
  const view = ledgerView(t);
  assert.ok(view.$("#ledger-nav"), "the sidebar offers the ledger view");
  view.controller.open();
  await tick();
  assert.equal(view.calls[0].path, "/api/projects/project_a/ledger");
  assert.equal(view.$("[data-project]").value, "project_a");
  assert.match(view.$("[data-list]").textContent, /登录记住设备/);

  // Switching project reads that project's ledger, not the previous one.
  const select = view.$("[data-project]");
  select.children[0].removeAttribute("selected");
  select.children[1].setAttribute("selected", "");
  select.dispatchEvent(new view.window.Event("change"));
  await tick();
  assert.equal(view.calls.at(-1).path, "/api/projects/project_b/ledger");
  assert.match(view.$("[data-list]").textContent, /报表导出/);
  assert.doesNotMatch(view.$("[data-list]").textContent, /登录记住设备/);

  // Back to A, then query text narrows the list through the HTTP query parameter.
  select.children[1].removeAttribute("selected");
  select.children[0].setAttribute("selected", "");
  select.dispatchEvent(new view.window.Event("change"));
  await tick();
  const query = view.$("[data-query]");
  query.value = "设备";
  query.dispatchEvent(new view.window.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.match(view.calls.at(-1).path, /^\/api\/projects\/project_a\/ledger\?q=%E8%AE%BE%E5%A4%87$/);
  assert.match(view.$("[data-list]").textContent, /登录记住设备/);

  // A new requirement is written to the selected project and shown afterwards.
  const form = view.$("[data-create]");
  form.querySelector('[name="title"]').value = "导出月度报表";
  form.querySelector('[name="content"]').value = "管理员每月导出一次。";
  form.dispatchEvent(new view.window.Event("submit", { cancelable: true }));
  await tick();
  const write = view.calls.filter((call) => call.options?.method === "POST").at(-1);
  assert.equal(write.path, "/api/projects/project_a/ledger");
  assert.deepEqual(
    { action: JSON.parse(write.options.body).action, title: JSON.parse(write.options.body).title },
    { action: "create", title: "导出月度报表" }
  );
  assert.equal(JSON.parse(write.options.body).source.kind, "internal");
  assert.equal(view.toasts.at(-1), "需求已记录");
  assert.equal(form.querySelector('[name="title"]').value, "");
});

test("ledger view shows a requirement's decisions and can retract one", async (t) => {
  const view = ledgerView(t);
  view.controller.open();
  await tick();
  view.$("[data-list] button").click();
  await tick();
  assert.match(view.$("[data-detail]").textContent, /使用设备令牌/);
  const retract = view.$("[data-decide]");
  assert.equal(retract.dataset.effective, "true");
  retract.click();
  await tick();
  const body = JSON.parse(view.calls.filter((call) => call.options?.method === "POST").at(-1).options.body);
  assert.equal(body.action, "set_decision_effective");
  assert.equal(body.decisionId, "decision_a");
  assert.equal(body.effective, false);
  assert.equal(view.$("[data-decide]").dataset.effective, "false");
});

test("ledger configuration is checked when the tool runs, not when it registers", async () => {
  const token = "fixture-ledger-token";
  const cases = [
    [{ dashboardUrl: "http://127.0.0.1:1", taskId: "task-a", token: "" }, /本次运行没有本地服务凭据/],
    [{ dashboardUrl: "http://127.0.0.1:1", taskId: "bad task", token }, /当前会话 ID 不合法/],
    [{ dashboardUrl: "http://example.test:3880", taskId: "task-a", token }, /不是回环 HTTP 地址/]
  ];
  for (const [options, expected] of cases) {
    // Construction is what runs at extension registration; it must stay total.
    const tool = createProjectLedgerTool(options);
    assert.equal(tool.name, "project_ledger");
    await assert.rejects(tool.execute({ action: "query" }), (error) => {
      assert.match(error.message, /项目台账工具不可用/);
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(token), "no credential in the error");
      assert.ok(!error.message.includes(options.dashboardUrl), "no address in the error");
      return true;
    });
  }
  // A refused first call does not poison the tool: a later credential works.
  const previous = process.env.COWORK_API_TOKEN;
  try {
    delete process.env.COWORK_API_TOKEN;
    const retry = createProjectLedgerTool({ dashboardUrl: "http://127.0.0.1:1", taskId: "task-a" });
    await assert.rejects(retry.execute({ action: "query" }), /没有本地服务凭据/);
    process.env.COWORK_API_TOKEN = token;
    await assert.rejects(retry.execute({ action: "query" }), (error) => {
      assert.doesNotMatch(error.message, /没有本地服务凭据/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.COWORK_API_TOKEN;
    else process.env.COWORK_API_TOKEN = previous;
  }
});

async function toolFixture(t) {
  const dashboard = await startDashboard({
    defaultProject: false,
    config: { projectData: projectDataConfig("sqlite") }
  });
  t.after(() => dashboard.stop());
  const request = async (path, body, method = "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const createProject = async (name) => {
    const directory = join(dashboard.root, `tool-${name}`);
    await mkdir(directory, { recursive: true });
    const response = await request("/api/projects", { projectName: name, projectDirectory: directory });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.project;
  };
  const a = await createProject("项目 A");
  const b = await createProject("项目 B");
  for (const [taskId, projectId] of [
    ["task-a", a.projectId],
    ["task-b", b.projectId]
  ]) {
    const created = await request("/api/tasks", { taskId, goal: taskId, projectId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
  assert.ok(instance.value?.token, "the serving backend published its local credential");
  return { ...dashboard, request, a, b, token: instance.value.token };
}

test("the Main tool reads and writes only the current project through the production bridge", async (t) => {
  const f = await toolFixture(t);
  const seen = [];
  const tool = createProjectLedgerTool({
    dashboardUrl: f.base,
    taskId: "task-a",
    token: f.token
  });
  const toolB = createProjectLedgerTool({ dashboardUrl: f.base, taskId: "task-b", token: f.token });
  const remember = (value) => {
    seen.push(JSON.stringify(value));
    return value;
  };

  const created = remember(
    await tool.execute({
      action: "create",
      title: "登录记住设备",
      content: "同一台设备 30 天内不再验证。",
      sourceKind: "internal"
    })
  );
  assert.equal(created.requirement.projectId, f.a.projectId);
  assert.equal(created.requirement.source.kind, "internal");
  assert.deepEqual(
    created.requirement.references.map((reference) => [reference.kind, reference.value]),
    [["task", "task-a"]]
  );
  const requirementId = created.requirement.requirementId;

  const read = remember(await tool.execute({ action: "query", q: "设备" }));
  assert.equal(read.projectId, f.a.projectId);
  assert.equal(read.requirements.length, 1);

  const revised = remember(
    await tool.execute({
      action: "update",
      requirementId,
      expectedRevision: 1,
      content: "同一台设备 30 天内不再验证；敏感操作仍需验证。",
      note: "补充敏感操作"
    })
  );
  assert.equal(revised.requirement.revision, 2);
  assert.equal(revised.requirement.revisions[1].taskId, "task-a");

  const decided = remember(
    await tool.execute({
      action: "decide",
      requirementId,
      expectedRevision: 2,
      text: "使用本机设备令牌。"
    })
  );
  assert.equal(decided.requirement.decisions[0].effective, true);

  // The other conversation's project never sees this requirement.
  const otherRead = remember(await toolB.execute({ action: "query" }));
  assert.equal(otherRead.projectId, f.b.projectId);
  assert.deepEqual(otherRead.requirements, []);
  await assert.rejects(
    toolB.execute({ action: "get", requirementId }),
    (error) => error.status === 404 && !JSON.stringify(error.message).includes(f.token)
  );
  // A project id in the body is not a selector: the Task's project still wins.
  const ignored = remember(await toolB.execute({ action: "query", projectId: f.a.projectId }));
  assert.equal(ignored.projectId, f.b.projectId);
  assert.deepEqual(ignored.requirements, []);

  // A crafted project URL with another Task's scope header is refused.
  const denied = await fetch(`${f.base}/api/projects/${encodeURIComponent(f.b.projectId)}/ledger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atria-token": f.token,
      "x-cowork-task-id": "task-a"
    },
    body: JSON.stringify({ action: "query" })
  });
  const deniedBody = await denied.json();
  assert.equal(denied.status, 403);
  assert.equal(deniedBody.code, "project_scope_denied");
  assert.ok(!JSON.stringify(deniedBody).includes(f.token));

  await assert.rejects(
    tool.execute({ action: "update", requirementId, expectedRevision: 1, title: "过期写入" }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "revision_conflict");
      assert.match(error.message, /需求已更新/);
      assert.ok(!error.message.includes(f.token), "the error carries no credential");
      return true;
    }
  );

  // Everything the Agent saw, and the tool's own description, stay credential-free.
  const page = await f.request("/api/project-data", undefined, "GET");
  seen.push(JSON.stringify(page.body));
  seen.push(tool.description);
  for (const value of seen) assert.ok(!value.includes(f.token), "no response leaks the local credential");
});
