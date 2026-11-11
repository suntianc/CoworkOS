import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { installUserMemorySettings } from "../web/assets/controllers/user-memory-settings.js";

test("memory use and automatic learning are independent and failed changes restore their controls", async (t) => {
  const { window } = parseHTML(
    '<html><body><div id="settings-entry" hidden><div id="profile-settings-tools"></div></div></body></html>'
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver
  };
  Object.assign(globalThis, { window, document: window.document, MutationObserver: window.MutationObserver });
  t.after(() => Object.assign(globalThis, previous));
  let value = { enabled: false, learningEnabled: false };
  let fail = false;
  let pending;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    await pending;
    const change = options.body ? JSON.parse(options.body) : undefined;
    requests.push(change);
    if (fail) return { ok: false, json: async () => ({ error: "保存失败" }) };
    if (change?.action === "set_learning") value.learningEnabled = change.enabled;
    if (change?.action === "set_enabled") value.enabled = change.enabled;
    if (change?.action === "set_learning_options") value.learningOptions = change.options;
    return { ok: true, json: async () => structuredClone(value) };
  };
  const errors = [];
  installUserMemorySettings({ showToast: (error) => errors.push(error) });
  const flush = () => new Promise((done) => setImmediate(done));
  await flush();
  assert.equal(window.document.querySelector('[role="dialog"]'), null);
  const use = window.document.querySelector("[data-memory-use]");
  const learn = window.document.querySelector("[data-memory-learn]");
  assert.equal(learn.disabled, true);
  assert.equal(use.checked, false);
  let finishRequest;
  pending = new Promise((resolve) => {
    finishRequest = resolve;
  });
  use.checked = true;
  use.dispatchEvent(new window.Event("change"));
  assert.equal(use.checked, true, "pending requests must not immediately undo the user's toggle");
  assert.equal(use.disabled, true);
  finishRequest();
  pending = undefined;
  await flush();
  assert.deepEqual(requests.at(-1), { action: "set_enabled", enabled: true });
  assert.deepEqual(value, { enabled: true, learningEnabled: false });
  assert.equal(learn.disabled, false);
  assert.equal(learn.checked, false);
  learn.checked = true;
  learn.dispatchEvent(new window.Event("change"));
  await flush();
  assert.deepEqual(requests.at(-1), { action: "set_learning", enabled: true });
  assert.deepEqual(value, { enabled: true, learningEnabled: true });
  fail = true;
  use.checked = false;
  use.dispatchEvent(new window.Event("change"));
  await flush();
  assert.equal(use.checked, true);
  assert.deepEqual(errors, ["保存失败"]);
  fail = false;
  use.checked = false;
  use.dispatchEvent(new window.Event("change"));
  await flush();
  assert.deepEqual(value, { enabled: false, learningEnabled: true });
  assert.equal(use.checked, false);
  assert.equal(learn.disabled, false, "paused learning can be disabled without re-enabling memory");
  learn.checked = false;
  learn.dispatchEvent(new window.Event("change"));
  await flush();
  assert.deepEqual(value, { enabled: false, learningEnabled: false });
  assert.equal(learn.disabled, true);

  const model = window.document.querySelector("[data-memory-model]");
  const tokens = window.document.querySelector("[data-memory-tokens]");
  const limit = window.document.querySelector("[data-memory-limit]");
  const form = window.document.querySelector("[data-memory-options]");
  model.value = "background-small";
  tokens.value = "1024";
  limit.value = "4";
  model.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await flush();
  assert.deepEqual(requests.at(-1), {
    action: "set_learning_options",
    options: { model: "background-small", maxTokens: 1024, maxRequestsPerHour: 4 }
  });
  assert.equal(window.document.querySelector("[data-memory-options-result]").textContent, "学习设置已保存");
  const beforeInvalid = requests.length;
  limit.value = "1";
  limit.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await flush();
  assert.equal(requests.length, beforeInvalid);
  assert.match(window.document.querySelector("[data-memory-options-result]").textContent, /检查/);
});
