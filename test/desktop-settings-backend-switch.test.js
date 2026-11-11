import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { installWebSearchSettings } from "../web/assets/controllers/web-search-settings.js";
import { installDesktopSettings } from "../web/assets/controllers/desktop-settings.js";
import { createSettingsBackend } from "../web/assets/controllers/settings-backend.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a delayed request remains stale after switching A to B and back to A", async () => {
  let current = "a";
  let complete;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  const settings = createSettingsBackend({ identity: () => current, api: () => pending });
  settings.bind();
  const result = settings.request("/api/model-settings", { method: "GET" });
  current = "b";
  settings.bind();
  current = "a";
  settings.bind();
  complete({ model: "late-from-a" });
  await assert.rejects(result, /后端已切换/);
});

function searchFixture(t, intercept) {
  const { window, document } = parseHTML('<html><body><div id="profile-settings-tools"></div></body></html>');
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  t.after(() => Object.assign(globalThis, previous));
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 1, height: 1 }];
  };
  let backend = "a";
  const requests = [];
  const saved = {
    a: { enabled: true, provider: "exa", authenticated: false, managedByEnvironment: false },
    b: { enabled: false, provider: "off", authenticated: false, managedByEnvironment: false }
  };
  installWebSearchSettings({
    showToast() {},
    host: { close: () => true, open() {}, onSection: () => () => {} },
    identity: () => backend,
    async api(path, options) {
      const target = backend;
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ target, path, method: options.method, body });
      if (body)
        saved[target] = { ...saved[target], provider: body.provider, enabled: body.provider !== "off" };
      const value = { ...saved[target] };
      return intercept ? intercept({ target, method: options.method, value }) : value;
    }
  });
  const panel = document.querySelector(".settings-backdrop");
  const form = panel.querySelector("form");
  const elements = Object.fromEntries(
    [...form.querySelectorAll("[name]")].map((element) => [element.name, element])
  );
  Object.defineProperty(form, "elements", { value: elements });
  Object.defineProperty(elements.provider, "value", { value: "exa", writable: true });
  return {
    panel,
    form,
    elements,
    requests,
    saved,
    switchBackend(value) {
      backend = value;
    },
    async open() {
      document.querySelector("[data-search-open]").click();
      await tick();
    },
    close() {
      panel.querySelector("[data-search-close]").click();
    },
    async save() {
      form.dispatchEvent(new window.Event("submit", { cancelable: true }));
      await tick();
    },
    edit() {
      form.dispatchEvent(new window.Event("input"));
    }
  };
}

test("search settings retain A's draft while reopening, reading and saving B", async (t) => {
  const f = searchFixture(t);
  await f.open();
  f.elements.exaApiKey.value = "unsaved-key-a";
  f.edit();
  f.close();
  f.switchBackend("b");
  await f.open();
  assert.equal(f.elements.provider.value, "off");
  assert.equal(f.elements.exaApiKey.value, "");
  f.close();
  await f.open();
  f.elements.provider.value = "exa";
  f.elements.exaApiKey.value = "saved-key-b";
  f.edit();
  await f.save();
  const bSave = f.requests.find((request) => request.target === "b" && request.method === "POST");
  assert.equal(bSave.body.exaApiKey, "saved-key-b");
  assert.equal(f.saved.b.provider, "exa");
  assert.equal(
    f.requests.some((request) => request.target === "a" && request.method === "POST"),
    false
  );
  f.switchBackend("a");
  await f.open();
  assert.equal(f.elements.exaApiKey.value, "unsaved-key-a");
});

function modelFixture(t, intercept) {
  const { window, document } = parseHTML(
    '<html><body><div id="profile-settings-connections"></div><div id="settings-role-rows"></div><div id="profile-settings-tools"></div></body></html>'
  );
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  t.after(() => Object.assign(globalThis, previous));
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 1, height: 1 }];
  };
  let backend = "a";
  const requests = [];
  const profile = (id, model) => ({
    id,
    name: `Profile ${id}`,
    baseUrl: `https://${id}.invalid/v1`,
    model,
    api: "openai-completions",
    configured: true
  });
  const saved = { a: profile("a", "model-a"), b: profile("b", "model-b") };
  const status = (value) => ({
    ...value,
    activeProfileId: value.id,
    visionProfileId: "",
    profiles: [value],
    managedByEnvironment: false
  });
  const modelSettings = installDesktopSettings({
    showToast() {},
    host: { close: () => true, open() {}, onSection: () => () => {} },
    identity: () => backend,
    async api(path, options) {
      const target = backend;
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ target, path, method: options.method, body });
      if (body) saved[target] = { ...saved[target], ...body };
      const value = status(saved[target]);
      return intercept ? intercept({ target, method: options.method, value }) : value;
    }
  });
  const panel = document.querySelector("[aria-labelledby=model-settings-title]").parentNode;
  const form = panel.querySelector("form");
  const elements = Object.fromEntries(
    [...form.querySelectorAll("[name]")].map((element) => [element.name, element])
  );
  Object.defineProperty(form, "elements", { value: elements });
  form.reportValidity = () => true;
  for (const select of form.querySelectorAll("select"))
    Object.defineProperty(select, "value", {
      value: select.querySelector("option")?.value || "",
      writable: true
    });
  return {
    panel,
    form,
    elements,
    requests,
    saved,
    switchBackend(value) {
      backend = value;
    },
    async open() {
      void modelSettings.open();
      await tick();
    },
    close() {
      panel.querySelector("[data-model-close]").click();
    },
    async save() {
      form.dispatchEvent(new window.Event("submit", { cancelable: true }));
      await tick();
    },
    edit() {
      form.dispatchEvent(new window.Event("input"));
    }
  };
}

test("model settings retain A's draft while reopening, reading and saving B", async (t) => {
  const f = modelFixture(t);
  await f.open();
  f.elements.model.value = "unsaved-model-a";
  f.elements.apiKey.value = "unsaved-key-a";
  f.elements.contextWindow.value = "";
  f.elements.mainMaxTokens.value = "2048";
  f.elements.subagentMaxTokens.value = "";
  f.edit();
  f.close();
  f.switchBackend("b");
  await f.open();
  assert.equal(f.elements.model.value, "model-b");
  assert.equal(f.elements.apiKey.value, "");
  f.close();
  await f.open();
  f.elements.model.value = "saved-model-b";
  f.elements.apiKey.value = "saved-key-b";
  f.edit();
  await f.save();
  const bSave = f.requests.find((request) => request.target === "b" && request.method === "POST");
  assert.equal(bSave.body.model, "saved-model-b");
  assert.equal(bSave.body.apiKey, "saved-key-b");
  assert.equal(f.saved.b.model, "saved-model-b");
  assert.equal(
    f.requests.some((request) => request.target === "a" && request.method === "POST"),
    false
  );
  f.switchBackend("a");
  await f.open();
  assert.equal(f.elements.model.value, "unsaved-model-a");
  assert.equal(f.elements.apiKey.value, "unsaved-key-a");
  assert.equal(f.elements.contextWindow.value, "");
  assert.equal(f.elements.mainMaxTokens.value, "2048");
  assert.equal(f.elements.subagentMaxTokens.value, "");
});

for (const [kind, fixture] of [
  ["search", searchFixture],
  ["model", modelFixture]
]) {
  test(`${kind} settings retry a failed backend read on reopen`, async (t) => {
    let first = true;
    const f = fixture(t, ({ method, value }) => {
      if (first && method === "GET") {
        first = false;
        throw new Error("temporary read failure");
      }
      return value;
    });
    await f.open();
    assert.match(f.panel.textContent, /temporary read failure/);
    f.close();
    await f.open();
    assert.equal(
      kind === "search" ? f.elements.provider.value : f.elements.model.value,
      kind === "search" ? "exa" : "model-a"
    );
    assert.equal(kind === "search" ? f.elements.provider.disabled : f.elements.model.disabled, false);
  });

  test(`${kind} settings can follow the reopen instruction after a backend switch`, async (t) => {
    const f = fixture(t);
    await f.open();
    if (kind === "search") f.elements.exaApiKey.value = "retained-key-a";
    else f.elements.apiKey.value = "retained-key-a";
    f.edit();
    f.switchBackend("b");
    await f.save();
    assert.match(f.panel.textContent, /后端已切换，请重新打开设置后重试/);
    assert.equal(
      f.requests.some((request) => request.method === "POST"),
      false
    );
    f.close();
    await f.open();
    assert.equal(
      kind === "search" ? f.elements.provider.value : f.elements.model.value,
      kind === "search" ? "off" : "model-b"
    );
    assert.equal(kind === "search" ? f.elements.exaApiKey.value : f.elements.apiKey.value, "");
    f.close();
    f.switchBackend("a");
    await f.open();
    assert.equal(kind === "search" ? f.elements.exaApiKey.value : f.elements.apiKey.value, "retained-key-a");
  });

  test(`${kind} settings ignore a delayed A read after opening B`, async (t) => {
    let finish;
    const delayed = new Promise((resolve) => {
      finish = resolve;
    });
    const f = fixture(t, ({ target, method, value }) =>
      target === "a" && method === "GET" ? delayed.then(() => value) : value
    );
    await f.open();
    f.close();
    f.switchBackend("b");
    await f.open();
    const value = () => (kind === "search" ? f.elements.provider.value : f.elements.model.value);
    assert.equal(value(), kind === "search" ? "off" : "model-b");
    finish();
    await tick();
    assert.equal(value(), kind === "search" ? "off" : "model-b");
    assert.equal(f.panel.hidden, false);
  });

  test(`${kind} settings retain a pending A save when its failure arrives on B`, async (t) => {
    let fail;
    const delayed = new Promise((_, reject) => {
      fail = reject;
    });
    const f = fixture(t, ({ target, method, value }) =>
      target === "a" && method === "POST" ? delayed : value
    );
    await f.open();
    if (kind === "search") f.elements.exaApiKey.value = "pending-key-a";
    else {
      f.elements.model.value = "pending-model-a";
      f.elements.apiKey.value = "pending-key-a";
    }
    f.edit();
    await f.save();
    f.close();
    f.switchBackend("b");
    await f.open();
    if (kind === "model") assert.equal(f.form.querySelector('button[type="submit"]').textContent, "保存连接");
    fail(new Error("A save failed"));
    await tick();
    assert.equal(f.panel.hidden, false);
    assert.equal(
      kind === "search" ? f.elements.provider.value : f.elements.model.value,
      kind === "search" ? "off" : "model-b"
    );
    assert.equal(f.panel.textContent.includes("A save failed"), false);
    f.close();
    f.switchBackend("a");
    await f.open();
    assert.equal(kind === "search" ? f.elements.exaApiKey.value : f.elements.apiKey.value, "pending-key-a");
  });

  test(`${kind} settings keep B open after a delayed successful A save`, async (t) => {
    let finish;
    const delayed = new Promise((resolve) => {
      finish = resolve;
    });
    const f = fixture(t, ({ target, method, value }) =>
      target === "a" && method === "POST" ? delayed.then(() => value) : value
    );
    await f.open();
    if (kind === "search") f.elements.exaApiKey.value = "pending-key-a";
    else f.elements.apiKey.value = "pending-key-a";
    f.edit();
    await f.save();
    f.close();
    f.switchBackend("b");
    await f.open();
    finish();
    await tick();
    assert.equal(f.panel.hidden, false);
    assert.equal(
      kind === "search" ? f.elements.provider.value : f.elements.model.value,
      kind === "search" ? "off" : "model-b"
    );
    f.close();
    f.switchBackend("a");
    await f.open();
    assert.equal(kind === "search" ? f.elements.exaApiKey.value : f.elements.apiKey.value, "pending-key-a");
  });
}
