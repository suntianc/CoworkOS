import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createFirstUseView } from "../web/assets/controllers/first-use.js";

function fixture(t, { modelConfigured, projectCount = 0 }) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = document;
  const $ = (selector) => document.querySelector(selector);
  const state = { modelConfigured, selected: null };
  const calls = [];
  const projects = { count: projectCount };
  const view = createFirstUseView({
    state,
    $,
    projectCount: () => projects.count,
    onConnectModel: () => calls.push("model"),
    onAddProject: () => calls.push("project"),
    onStartSession: () => calls.push("session")
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { $, state, view, calls, projects };
}

const step = (fixture_) => (key) => fixture_.$(`.first-use-step[data-step="${key}"]`);

test("a fresh data directory starts on the model step and locks the composer", (t) => {
  const page = fixture(t, { modelConfigured: false });
  page.view.render();

  const welcome = page.$(".first-use");
  assert.ok(welcome, "the welcome surface renders");
  assert.equal(page.$(".first-use-title").textContent, "欢迎使用 Formicand");
  assert.equal(page.$("#conversation").querySelectorAll(".first-use-step").length, 3);

  const stepOf = step(page);
  assert.equal(stepOf("model").getAttribute("data-state"), "current");
  assert.equal(stepOf("model").getAttribute("aria-current"), "step");
  assert.equal(stepOf("model").querySelector(".first-use-label").textContent, "连接模型");
  assert.equal(stepOf("project").getAttribute("data-state"), "pending");
  assert.equal(stepOf("session").getAttribute("data-state"), "pending");
  assert.equal(stepOf("session").querySelector("button").disabled, true);

  assert.equal(page.view.active(), true);
  assert.equal(page.view.blocksSending(), true);
  page.view.sync();
  assert.equal(page.$("#composer-input").placeholder, "连接模型并添加项目后即可开始…");

  stepOf("model").querySelector("button").click();
  stepOf("project").querySelector("button").click();
  assert.deepEqual(page.calls, ["model", "project"]);
});

test("a configured model completes its step and hands the next action to adding a project", (t) => {
  const page = fixture(t, { modelConfigured: true });
  page.view.render();

  const stepOf = step(page);
  assert.equal(stepOf("model").getAttribute("data-state"), "done");
  assert.equal(stepOf("model").querySelector(".first-use-num").getAttribute("aria-label"), "已完成");
  assert.equal(stepOf("model").querySelector("button"), null, "a completed step offers no action");
  assert.equal(stepOf("project").getAttribute("data-state"), "current");
  assert.equal(stepOf("session").getAttribute("data-state"), "pending");
  // A message without a project still starts a temporary session, so the
  // missing project does not take the composer away.
  assert.equal(page.view.blocksSending(), false);

  page.view.sync();
  assert.equal(page.$("#composer-input").placeholder, "描述任务，或添加后续要求…");
});

test("the guide follows the catalog: it leaves once a project exists and returns when none does", (t) => {
  const page = fixture(t, { modelConfigured: true, projectCount: 1 });
  assert.equal(page.view.active(), false, "a usable model and one project is the normal entry");
  assert.equal(page.view.blocksSending(), false);

  page.projects.count = 0;
  assert.equal(page.view.active(), true);
  page.view.render();
  assert.equal(step(page)("project").getAttribute("data-state"), "current");

  page.projects.count = 1;
  assert.equal(page.view.active(), false, "nothing stored a completed guide");
});

test("the composer returns to its own placeholder after the guide leaves", (t) => {
  const page = fixture(t, { modelConfigured: false });
  page.$("#composer-input").placeholder = "描述需求";
  page.view.sync();
  assert.equal(page.$("#composer-input").placeholder, "连接模型并添加项目后即可开始…");

  page.state.modelConfigured = true;
  page.projects.count = 1;
  page.view.sync();
  assert.equal(page.$("#composer-input").placeholder, "描述需求");
  assert.equal(page.view.blocksSending(), false);
});

test("an open conversation keeps its own send semantics while the model is missing", (t) => {
  const page = fixture(t, { modelConfigured: false });
  page.state.selected = "task-1";
  assert.equal(page.view.blocksSending(), false);
});
