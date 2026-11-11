import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createEntryController } from "../web/assets/controllers/entry-controller.js";

function shell() {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div class="app-layout" data-entry="work">
      <button data-entry-mode="work" role="tab" aria-selected="true" aria-controls="work-entry">工作</button>
      <button data-entry-mode="observe" role="tab" aria-selected="false" aria-controls="observe-entry">观测</button>
      <div data-entry-panel="work" id="work-entry">工作内容</div>
      <section data-entry-panel="observe" id="observe-entry" hidden>
        <h1 id="observe-title">总览</h1>
        <nav aria-label="观测视图">
          <button data-observe-view="overview" aria-current="page">总览</button>
          <button data-observe-view="requirements">需求</button>
          <button data-observe-view="runs">运行</button>
        </nav>
        <section data-observe-panel="overview">总览内容</section>
        <section data-observe-panel="requirements" hidden>需求内容</section>
        <section data-observe-panel="runs" hidden>运行内容</section>
      </section>
      <button id="settings-entry">设置</button>
    </div>
  </body></html>`);
  return { document, root: document.querySelector(".app-layout") };
}

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    entries
  };
}

test("switching entries keeps each entry's own selection and the settings entry visible", () => {
  const { document, root } = shell();
  const changes = [];
  const controller = createEntryController({ root, onChange: (state) => changes.push(state) });
  assert.equal(root.dataset.entry, "work");
  assert.equal(document.querySelector('[data-entry-panel="work"]').hidden, false);
  assert.equal(document.querySelector('[data-entry-panel="observe"]').hidden, true);

  controller.setMode("observe");
  assert.equal(root.dataset.entry, "observe");
  assert.equal(document.querySelector('[data-entry-panel="work"]').hidden, true);
  assert.equal(document.querySelector('[data-entry-panel="observe"]').hidden, false);
  assert.equal(document.querySelector('[data-entry-mode="observe"]').getAttribute("aria-selected"), "true");
  assert.equal(document.querySelector('[data-entry-mode="work"]').getAttribute("aria-selected"), "false");
  assert.equal(document.querySelector("#settings-entry").hidden, false);

  controller.setObserveView("requirements");
  assert.equal(document.querySelector("#observe-title").textContent, "需求");
  assert.equal(document.querySelector('[data-observe-panel="overview"]').hidden, true);
  assert.equal(document.querySelector('[data-observe-panel="requirements"]').hidden, false);
  assert.equal(
    document.querySelector('[data-observe-view="requirements"]').getAttribute("aria-current"),
    "page"
  );

  controller.setMode("work");
  controller.setMode("observe");
  assert.equal(controller.state().observeView, "requirements");
  assert.equal(document.querySelector('[data-observe-panel="requirements"]').hidden, false);
  assert.equal(document.querySelector('[data-observe-panel="overview"]').hidden, true);
  assert.deepEqual(changes, [
    { mode: "observe", observeView: "overview" },
    { mode: "observe", observeView: "requirements" },
    { mode: "work", observeView: "requirements" },
    { mode: "observe", observeView: "requirements" }
  ]);
});

test("the last entry and observation view survive a reload", () => {
  const storage = memoryStorage();
  const first = shell();
  const controller = createEntryController({ root: first.root, storage });
  controller.setMode("observe");
  controller.setObserveView("runs");

  const reloaded = shell();
  const restored = createEntryController({ root: reloaded.root, storage });
  assert.equal(restored.state().mode, "observe");
  assert.equal(restored.state().observeView, "runs");
  assert.equal(reloaded.root.dataset.entry, "observe");
  assert.equal(reloaded.document.querySelector("#observe-title").textContent, "运行");
  assert.equal(reloaded.document.querySelector('[data-observe-panel="runs"]').hidden, false);
});

test("unknown stored values and blocked storage fall back to the work entry", () => {
  const stored = memoryStorage({ "atria.entry.v1": '{"mode":"galaxy","observeView":"nowhere"}' });
  const { root, document } = shell();
  const controller = createEntryController({ root, storage: stored });
  assert.equal(controller.state().mode, "work");
  assert.equal(controller.state().observeView, "overview");
  assert.equal(root.dataset.entry, "work");

  const broken = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    }
  };
  const blocked = shell();
  const fallback = createEntryController({ root: blocked.root, storage: broken });
  fallback.setMode("observe");
  assert.equal(blocked.root.dataset.entry, "observe");
  assert.equal(blocked.document.querySelector('[data-entry-panel="observe"]').hidden, false);
});
