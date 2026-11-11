import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createUserMemoryViewer } from "../web/assets/controllers/user-memory-viewer.js";

const flush = () => new Promise((done) => setImmediate(done));
function setup(t, fetch) {
  const { window } = parseHTML("<html><body></body></html>");
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window, document: window.document, fetch });
  window.HTMLElement.prototype.getClientRects = () => [1];
  t.after(() => Object.assign(globalThis, previous));
  const viewer = createUserMemoryViewer({ host: { open() {}, close: () => true } });
  const panel = document.querySelector(".modal-backdrop");
  const input = panel.querySelector("textarea");
  const form = panel.querySelector("form");
  return {
    viewer,
    panel,
    input,
    type(text) {
      input.value = text;
      input.dispatchEvent(new window.Event("input"));
    },
    submit() {
      form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    },
    reopen() {
      panel.querySelector("[data-memory-close]").click();
      viewer.open();
    }
  };
}

test("one memory editor displays saved text safely and reloads unchanged content on reopen", async (t) => {
  let value = { enabled: true, content: '<img src=x onerror="bad()">偏好简洁', revision: "a" };
  const ui = setup(t, async () => ({ ok: true, json: async () => value }));
  ui.viewer.open();
  await flush();
  assert.equal(ui.input.value, value.content);
  assert.equal(ui.panel.querySelector("img"), null);
  assert.equal(ui.panel.querySelectorAll("textarea").length, 1);
  assert.equal(ui.panel.querySelectorAll("article").length, 0);
  assert.equal(ui.input.getAttribute("maxlength"), "2000");
  value = { ...value, content: "新内容", revision: "b" };
  ui.reopen();
  await flush();
  assert.equal(ui.input.value, "新内容");
});

test("whole-profile editing preserves drafts on close and conflict and permits clearing", async (t) => {
  let value = { enabled: false, content: "原内容", revision: "a" },
    conflict = true;
  const writes = [];
  const ui = setup(t, async (_url, options) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      writes.push(body);
      if (conflict) return { ok: false, status: 409, json: async () => ({}) };
      value = { ...value, content: body.content, revision: "b" };
    }
    return { ok: true, json: async () => value };
  });
  ui.viewer.open();
  await flush();
  ui.type("手动更新");
  ui.reopen();
  await flush();
  assert.equal(ui.input.value, "手动更新");
  ui.submit();
  await flush();
  assert.match(ui.panel.textContent, /输入已保留/);
  assert.equal(ui.input.value, "手动更新");
  assert.deepEqual(writes[0], { action: "save_text", content: "手动更新", revision: "a" });
  conflict = false;
  ui.submit();
  await flush();
  assert.equal(ui.input.value, "手动更新");
  assert.match(ui.panel.textContent, /开启个人记忆后/);
  ui.type("");
  ui.submit();
  await flush();
  assert.equal(writes.at(-1).content, "");
});

test("oversized legacy memory is retained for editing; late reads cannot overwrite a closed editor", async (t) => {
  let release;
  let delayed = false;
  const ui = setup(t, async () => {
    if (delayed)
      await new Promise((done) => {
        release = done;
      });
    return { ok: true, json: async () => ({ enabled: true, content: "长".repeat(2200), revision: "a" }) };
  });
  ui.viewer.open();
  await flush();
  assert.equal(ui.input.value.length, 2200);
  assert.match(ui.panel.textContent, /旧版记忆超过/);
  assert.equal(ui.panel.querySelector("[type=submit]").disabled, true);
  delayed = true;
  ui.reopen();
  ui.panel.querySelector("[data-memory-close]").click();
  release();
  await flush();
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.input.value.length, 2200);
});
