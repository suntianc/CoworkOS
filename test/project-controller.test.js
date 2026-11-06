import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { createProjectController } from "../web/assets/controllers/project-controller.js";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";

const project = (id) => ({
  projectId: id,
  projectName: `项目${id}`,
  projectDirectory: `/tmp/${id}`,
  tasks: []
});
function fixture(t, request = async () => ({}), isTaskVisible) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const $ = (selector) => document.querySelector(selector);
  const state = {
    projects: [project("a"), project("b")],
    tasks: [],
    collapsedProjects: new Set(),
    selectedProjectId: "a",
    selected: null
  };
  const began = [],
    calls = [],
    applicationWorkspaces = [];
  let navigation = 0;
  const controller = createProjectController({
    state,
    $,
    api: async (path, options) => {
      calls.push({ path, options });
      return request(path, options);
    },
    beginConversation: (id) => {
      began.push(id);
      state.selected = null;
    },
    selectConversation: (id) => {
      state.selected = id;
    },
    conversationTitle: (task) => task.goal,
    stateText: (value) => value,
    shortDate: () => "",
    taskMenuOpen: () => false,
    openTaskMenu() {},
    showToast() {},
    getNavigationIdentity: () => navigation,
    getApplicationWorkspaces: () => applicationWorkspaces,
    isTaskVisible: isTaskVisible && ((task) => isTaskVisible(task, state))
  });
  t.after(() => {
    $("#project-cancel")?.click();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const submit = () => $("#project-form").onsubmit(new window.Event("submit", { cancelable: true }));
  return {
    state,
    $,
    window,
    controller,
    began,
    calls,
    submit,
    applicationWorkspaces,
    navigate: () => navigation++
  };
}

test("empty projects remain visible and project navigation creates only a draft", (t) => {
  const f = fixture(t);
  f.controller.render();
  assert.equal(f.$("#project-list").querySelectorAll("[data-project]").length, 2);
  assert.match(f.$('[data-project="a"]').textContent, /还没有对话/);
  f.$('[data-project-create="b"]').click();
  assert.deepEqual(f.began, ["b"]);
  assert.deepEqual(f.calls, []);
  f.$('[data-project-id="b"]').click();
  assert.equal(f.state.selectedProjectId, "b");
  assert.deepEqual(f.began, ["b", "b"]);
});

test("background goals stay outside project and temporary conversation lists until selected or pinned", (t) => {
  const f = fixture(
    t,
    undefined,
    (task, state) => task.monitoring?.scope !== "background" || task.pinned || task.taskId === state.selected
  );
  const ordinary = { taskId: "daily", projectId: "a", goal: "普通会话", status: "waiting" };
  const background = {
    taskId: "goal",
    projectId: "a",
    goal: "后台跟进",
    monitoring: { scope: "background" }
  };
  const pinned = { ...background, taskId: "pinned", pinned: true };
  const temporary = {
    ...background,
    taskId: "temporary-goal",
    projectId: undefined,
    temporaryWorkspaceRoot: "/tmp/background"
  };
  const legacy = { ...background, taskId: "legacy-goal", projectId: "legacy" };
  const archived = { ...pinned, taskId: "archived-goal", archived: true };
  f.controller.accept({
    projects: [project("a"), project("b"), { ...project("legacy"), legacy: true }],
    tasks: [ordinary, background, pinned, temporary, legacy, archived]
  });
  f.$("#composer-input").value = "保持普通会话草稿";
  f.controller.render();
  assert.ok(f.$('[data-task="daily"]'));
  assert.ok(f.$('[data-task="pinned"]'));
  assert.equal(f.$('[data-task="goal"]'), null);
  assert.equal(f.$('[data-task="temporary-goal"]'), null);
  assert.equal(f.$('[data-project="legacy"]'), null);
  assert.equal(f.$('[data-task="archived-goal"]'), null);
  assert.ok(f.$('[data-project-create="b"]'), "explicit empty projects retain the new conversation action");
  assert.equal(f.$("#conversation-count").textContent, "2");
  f.state.selected = "goal";
  f.controller.render();
  assert.ok(f.$('[data-task="goal"]'));
  assert.ok(f.$('[data-session-menu="goal"]'), "a selected goal keeps the modern conversation menu");
  assert.equal(f.$("#conversation-count").textContent, "3");
  f.state.selected = "temporary-goal";
  f.controller.render();
  assert.equal(f.$('[data-task="goal"]'), null);
  assert.ok(f.$('[data-task="temporary-goal"]'));
  assert.equal(f.$("#composer-input").value, "保持普通会话草稿");
});

test("explicit collaboration can establish a project without changing navigation or drafts", async (t) => {
  const created = { ...project("document"), projectDirectory: "/document-home", projectName: "文档协作" };
  const f = fixture(t, async () => ({ project: created }));
  f.state.selected = "current-chat";
  f.$("#composer-input").value = "保留当前草稿";
  assert.equal((await f.controller.ensureProject("/document-home", "文档协作")).projectId, created.projectId);
  assert.equal(f.state.selected, "current-chat");
  assert.equal(f.$("#composer-input").value, "保留当前草稿");
  assert.equal(f.calls.length, 1);
  await f.controller.ensureProject("/document-home", "文档协作");
  assert.equal(f.calls.length, 1, "reuse an existing project instead of creating duplicates");
});

test("legacy projects with only archived tasks disappear while document-only and explicit projects remain", (t) => {
  const f = fixture(t);
  f.state.projects.push({ ...project("old"), legacy: true, tasks: [{ taskId: "old", archived: true }] });
  f.state.projects.push({ ...project("documents"), legacy: true, hasApplications: true, tasks: [] });
  f.state.projects.push({ ...project("orphan"), legacy: true, tasks: [] });
  f.controller.render();
  assert.equal(f.$('[data-project="old"]'), null);
  assert.ok(f.$('[data-project="a"]'));
  assert.ok(f.$('[data-project="documents"]'));
  assert.equal(f.$('[data-project="orphan"]'), null);
  f.$('[data-project-create="documents"]').click();
  assert.deepEqual(f.began, ["documents"]);
  f.applicationWorkspaces.push("/tmp/old");
  f.controller.render();
  assert.ok(
    f.$('[data-project="old"]'),
    "an open document keeps its project accessible after conversation archival"
  );
});

test("cancelling project creation preserves the conversation and never submits a task", (t) => {
  const f = fixture(t);
  f.state.selected = "task-old";
  f.$("#composer-input").value = "未发送草稿";
  f.controller.openCreate();
  f.$("#project-name").value = "新项目";
  f.$("#project-directory").value = "/tmp/new";
  f.$("#project-cancel").click();
  assert.equal(f.$("#project-modal").hidden, true);
  assert.equal(f.state.selected, "task-old");
  assert.equal(f.$("#composer-input").value, "未发送草稿");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.began, []);
});

test("a directory picker only fills its own open dialog and ignores a late cancelled selection", async (t) => {
  const f = fixture(t);
  let release;
  f.window.bookmanDesktop = {
    chooseProject: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  };
  f.controller.openCreate();
  const pending = f.$("#project-directory-choose").onclick();
  f.$("#project-cancel").click();
  f.controller.openCreate();
  f.$("#project-name").value = "稍后打开的项目";
  release("/tmp/old");
  await pending;
  assert.equal(f.$("#project-directory").value, "");
  assert.equal(f.$("#project-name").value, "稍后打开的项目");
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.selectedProjectId, "a");
});

test("creation uses the project contract, preserves new selection during a delayed response and survives an older list", async (t) => {
  let release;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  f.controller.openCreate();
  f.$("#project-name").value = "新项目";
  f.$("#project-directory").value = "/tmp/new";
  const pending = f.submit();
  f.controller.select("b");
  f.navigate();
  release({ project: { ...project("new"), projectName: "新项目", updatedAt: "2026-10-11T01:00:00.000Z" } });
  await pending;
  const sent = f.calls[0].options.body;
  assert.deepEqual(typeof sent === "string" ? JSON.parse(sent) : sent, {
    projectName: "新项目",
    projectDirectory: "/tmp/new"
  });
  assert.equal(f.calls[0].path, "/api/projects");
  assert.equal(f.state.selectedProjectId, "b");
  assert.deepEqual(f.began, []);
  f.controller.accept({ projects: [project("a"), project("b")], tasks: [] });
  f.controller.render();
  assert.ok(f.$('[data-project="new"]'));
  assert.match(f.$('[data-project="new"]').textContent, /还没有对话/);
});

test("creating a project enters its empty draft and duplicate directory errors retain dialog input", async (t) => {
  let fail = false;
  const f = fixture(t, async () => {
    if (fail) throw new Error("该工作文件夹已属于另一个项目");
    return { project: project("new") };
  });
  f.controller.openCreate();
  f.$("#project-name").value = "新项目";
  f.$("#project-directory").value = "/tmp/new";
  await f.submit();
  assert.equal(f.state.selectedProjectId, "new");
  assert.deepEqual(f.began, ["new"]);
  fail = true;
  f.controller.openCreate();
  f.$("#project-name").value = "重复";
  f.$("#project-directory").value = "/tmp/new";
  await f.submit();
  assert.equal(f.$("#project-modal").hidden, false);
  assert.match(f.$("#project-error").textContent, /另一个项目/);
  assert.equal(f.$("#project-directory").value, "/tmp/new");
  assert.equal(f.state.tasks.length, 0);
});

test("project drafts and attachments restore separately from Task drafts across restart", () => {
  const records = new Map(),
    input = { value: "", addEventListener() {} };
  let attachments = [];
  const options = {
    input,
    storage: {
      getItem: (key) => records.get(key),
      setItem: (key, value) => records.set(key, value),
      removeItem: (key) => records.delete(key)
    },
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    }
  };
  const session = createComposerSession(options);
  session.activate(null, { projectId: "a" });
  input.value = "项目A草稿";
  attachments = [{ name: "a.txt", text: "A" }];
  session.save();
  session.activate(null, { projectId: "b" });
  assert.equal(input.value, "");
  assert.deepEqual(attachments, []);
  input.value = "项目B草稿";
  session.save();
  session.activate("task-a");
  input.value = "会话草稿";
  session.save();
  session.activate(null, { projectId: "a" });
  assert.equal(input.value, "项目A草稿");
  assert.equal(attachments[0].name, "a.txt");
  const restored = createComposerSession(options);
  assert.equal(restored.activeTask, null);
  assert.equal(restored.activeProject, "a");
  assert.equal(restored.hasNewDraft, true);
  restored.activate(null, { projectId: "b" });
  assert.equal(input.value, "项目B草稿");
  restored.activate("task-a");
  assert.equal(input.value, "会话草稿");
});

test("an existing global draft moves into its first project without losing attachments", () => {
  const records = new Map([
    ["atria.composer.v1:active", JSON.stringify("new")],
    [
      "atria.composer.v1:new",
      JSON.stringify({ text: "升级前的草稿", attachments: [{ name: "旧.txt", text: "旧" }] })
    ]
  ]);
  const input = { value: "", addEventListener() {} };
  let attachments = [];
  const session = createComposerSession({
    input,
    storage: {
      getItem: (key) => records.get(key),
      setItem: (key, value) => records.set(key, value),
      removeItem: (key) => records.delete(key)
    },
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    }
  });
  session.activate(null);
  session.activate(null, { projectId: "a" });
  assert.equal(input.value, "升级前的草稿");
  assert.equal(attachments[0].name, "旧.txt");
  assert.equal(records.has("atria.composer.v1:new"), false);
  session.activate(null, { projectId: "b" });
  assert.equal(input.value, "");
});

test("first project activation after reload recovers a legacy global draft without overwriting project drafts", () => {
  for (const active of ["new", "new:a"]) {
    const records = new Map([
      ["atria.composer.v1:active", JSON.stringify(active)],
      [
        "atria.composer.v1:new",
        JSON.stringify({ text: "恢复草稿", attachments: [{ name: "恢复.txt", text: "附件" }] })
      ]
    ]);
    const input = { value: "", addEventListener() {} };
    let attachments = [];
    const options = {
      input,
      storage: {
        getItem: (key) => records.get(key),
        setItem: (key, value) => records.set(key, value),
        removeItem: (key) => records.delete(key)
      },
      getAttachments: () => attachments,
      setAttachments: (files) => {
        attachments = files;
      }
    };
    const session = createComposerSession(options);
    session.activate(null, { projectId: "a" });
    assert.equal(input.value, "恢复草稿");
    assert.equal(attachments[0].name, "恢复.txt");
    assert.equal(records.has("atria.composer.v1:new"), false);
    session.activate(null, { projectId: "b" });
    assert.equal(input.value, "");
    session.activate(null, { projectId: "a" });
    assert.equal(input.value, "恢复草稿");
    records.set("atria.composer.v1:new", JSON.stringify({ text: "另一个旧草稿", attachments: [] }));
    createComposerSession(options).activate(null, { projectId: "a" });
    assert.equal(input.value, "恢复草稿");
    assert.equal(JSON.parse(records.get("atria.composer.v1:new")).text, "另一个旧草稿");
  }
});

test("legacy draft migration retains its durable source through quota failures and clears it after recovery", () => {
  const source = JSON.stringify({
    text: "必须恢复的旧草稿",
    attachments: [{ name: "恢复.txt", text: "完整附件" }]
  });
  const records = new Map([
    ["atria.composer.v1:active", JSON.stringify("new")],
    ["atria.composer.v1:new", source]
  ]);
  let quota = true;
  const storage = {
    getItem: (key) => records.get(key),
    setItem: (key, value) => {
      if (quota && key === "atria.composer.v1:new:a") throw new Error("destination quota exceeded");
      records.set(key, value);
    },
    removeItem: (key) => records.delete(key)
  };
  const create = () => {
    const input = { value: "", addEventListener() {} };
    let attachments = [];
    const warnings = [];
    const session = createComposerSession({
      input,
      storage,
      getAttachments: () => attachments,
      setAttachments: (value) => {
        attachments = value;
      },
      onError: (message) => warnings.push(message)
    });
    return { input, session, attachments: () => attachments, warnings };
  };
  const first = create();
  first.session.activate(null, { projectId: "a" });
  assert.equal(first.input.value, "必须恢复的旧草稿");
  assert.equal(first.attachments()[0].text, "完整附件");
  assert.ok(first.warnings.length);
  assert.equal(records.get("atria.composer.v1:new"), source);
  assert.equal(records.has("atria.composer.v1:new:a"), false);
  assert.equal(first.session.prepareClose(), false);
  assert.equal(records.get("atria.composer.v1:new"), source);

  const reloaded = create();
  reloaded.session.activate(null, { projectId: "a" });
  assert.equal(reloaded.input.value, "必须恢复的旧草稿");
  assert.equal(reloaded.attachments()[0].name, "恢复.txt");
  assert.equal(reloaded.session.prepareClose(), false);
  assert.equal(records.get("atria.composer.v1:new"), source);
  reloaded.input.value = "恢复后继续编辑的草稿";
  quota = false;
  assert.equal(reloaded.session.prepareClose(), true);
  assert.equal(records.has("atria.composer.v1:new"), false);
  const saved = JSON.parse(records.get("atria.composer.v1:new:a"));
  assert.equal(saved.text, "恢复后继续编辑的草稿");
  assert.equal(saved.attachments[0].text, "完整附件");
});

test("a recovered migration preserves a newer global draft written while its destination was unavailable", () => {
  for (const previouslySelected of [false, true]) {
    const records = new Map([
      ["atria.composer.v1:new", JSON.stringify({ text: "原始迁移草稿", attachments: [] })]
    ]);
    let quota = true;
    const input = { value: "", addEventListener() {} };
    const session = createComposerSession({
      input,
      storage: {
        getItem: (key) => records.get(key),
        setItem: (key, value) => {
          if (quota && key === "atria.composer.v1:new:a") throw new Error("destination quota exceeded");
          records.set(key, value);
        },
        removeItem: (key) => records.delete(key)
      },
      getAttachments: () => [],
      setAttachments() {}
    });
    if (previouslySelected) session.activate(null);
    session.activate(null, { projectId: "a" });
    assert.equal(input.value, "原始迁移草稿");
    const newerGlobal = JSON.stringify({ text: "另一个窗口的新全局草稿", attachments: [] });
    records.set("atria.composer.v1:new", newerGlobal);
    input.value = "迁移草稿的后续编辑";
    quota = false;
    assert.equal(session.prepareClose(), true);
    assert.equal(JSON.parse(records.get("atria.composer.v1:new:a")).text, "迁移草稿的后续编辑");
    assert.equal(
      records.get("atria.composer.v1:new"),
      newerGlobal,
      `preserve source with cached=${previouslySelected}`
    );
  }
});

test("an existing project draft prevents legacy source cleanup even after a failed storage write recovers", () => {
  const source = JSON.stringify({ text: "独立旧草稿", attachments: [] });
  const records = new Map([
    ["atria.composer.v1:new", source],
    ["atria.composer.v1:new:a", JSON.stringify({ text: "A 已有草稿", attachments: [] })]
  ]);
  let quota = true;
  const input = { value: "", addEventListener() {} };
  const session = createComposerSession({
    input,
    storage: {
      getItem: (key) => records.get(key),
      setItem: (key, value) => {
        if (quota && key === "atria.composer.v1:new:a") throw new Error("destination quota exceeded");
        records.set(key, value);
      },
      removeItem: (key) => records.delete(key)
    },
    getAttachments: () => [],
    setAttachments() {}
  });
  session.activate(null, { projectId: "a" });
  assert.equal(input.value, "A 已有草稿");
  assert.equal(session.prepareClose(), false);
  quota = false;
  assert.equal(session.prepareClose(), true);
  assert.equal(JSON.parse(records.get("atria.composer.v1:new:a")).text, "A 已有草稿");
  assert.equal(records.get("atria.composer.v1:new"), source);
});

test("legacy empty migration groups require document evidence while named empty projects survive", (t) => {
  const f = fixture(t);
  f.state.projects.push({ ...project("workspace"), legacy: true, tasks: [] });
  f.state.projects.push({ ...project("test"), legacy: true, tasks: [] });
  f.state.projects.push({ ...project("kept"), legacy: true, hasApplications: true, tasks: [] });
  f.controller.render();
  assert.equal(f.$('[data-project="workspace"]'), null);
  assert.equal(f.$('[data-project="test"]'), null);
  assert.ok(f.$('[data-project="kept"]'));
  assert.ok(f.$('[data-project="a"]'));
});
