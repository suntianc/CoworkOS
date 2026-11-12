import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createLiveBrowser } from "./live-ui-harness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("live DOM navigation uses the Dashboard URL and restores browser globals", async () => {
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  const view = createLiveBrowser("http://fixture.invalid:4321");
  try {
    assert.equal(view.window.location.href, "http://fixture.invalid:4321/");
    assert.equal(globalThis.location, view.window.location);
    assert.equal(globalThis.history, view.window.history);
    assert.equal(view.window.location.hash, "");
    assert.deepEqual(view.historyCalls, []);

    view.window.history.pushState(null, "", "#goals");
    assert.equal(globalThis.location.hash, "#goals");
    assert.equal(view.historyCalls.length, 1);
    view.window.history.replaceState(null, "", "/workspace?view=conversation#draft");
    assert.equal(globalThis.location.pathname, "/workspace");
    assert.equal(globalThis.location.search, "?view=conversation");
    assert.equal(globalThis.location.hash, "#draft");
    view.window.history.pushState(null, "", location.pathname + location.search);
    assert.equal(globalThis.location.href, "http://fixture.invalid:4321/workspace?view=conversation");
    assert.equal(view.historyCalls.length, 2);
  } finally {
    view.restore();
  }
  assert.equal(globalThis.location, previousLocation);
  assert.equal(globalThis.history, previousHistory);
});

test("teardown drains an editor debounce and its delayed body before removing the DOM", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  const body = deferred();
  const readingBody = deferred();
  globalThis.fetch = async () => ({
    text() {
      readingBody.resolve();
      return body.promise;
    }
  });
  const view = createLiveBrowser("http://fixture.invalid");
  try {
    const input = view.$("#composer-input");
    input.addEventListener("input", () => {
      setTimeout(async () => {
        const value = await (await fetch("/fixture-save")).text();
        document.querySelector("#composer-input").dataset.saved = value;
      }, 400);
    });
    input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
    let drained = false;
    const quiescence = view.quiesce().then(() => (drained = true));
    t.mock.timers.tick(399);
    await setImmediate();
    assert.equal(drained, false);
    t.mock.timers.tick(1);
    await readingBody.promise;
    await setImmediate();
    assert.equal(drained, false);
    body.resolve("saved");
    await quiescence;
    assert.equal(input.dataset.saved, "saved");
  } finally {
    body.resolve("saved");
    await setImmediate();
    view.restore();
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("an unresolved body fails cleanup within its deadline and keeps the DOM until it drains", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  const body = deferred();
  const readingBody = deferred();
  globalThis.fetch = async () => ({
    json() {
      readingBody.resolve();
      return body.promise;
    }
  });
  const view = createLiveBrowser("http://fixture.invalid");
  try {
    const read = fetch("/fixture-stalled-body").then((response) => response.json());
    await readingBody.promise;
    const failure = assert.rejects(view.quiesce({ timeoutMs: 100 }), /cleanup timed out/);
    t.mock.timers.tick(100);
    await failure;
    assert.equal(globalThis.document, view.document);
    body.resolve({ saved: true });
    assert.deepEqual(await read, { saved: true });
    await view.quiesce();
  } finally {
    body.resolve({ saved: true });
    await setImmediate();
    view.restore();
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("an async DOM callback rejection remains a cleanup failure", async () => {
  const view = createLiveBrowser("http://fixture.invalid");
  const gate = deferred();
  try {
    const button = view.$("#send-button");
    button.addEventListener("click", async () => {
      await gate.promise;
      throw new Error("fixture callback rejected");
    });
    button.dispatchEvent(new view.window.Event("click"));
    const quiescence = view.quiesce();
    gate.resolve();
    await assert.rejects(
      quiescence,
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((failure) => failure.message === "fixture callback rejected")
    );
    assert.equal(globalThis.document, view.document);
  } finally {
    gate.resolve();
    await setImmediate();
    view.restore();
  }
});

test("event instrumentation preserves duplicate registration and listener removal", async () => {
  const view = createLiveBrowser("http://fixture.invalid");
  try {
    const button = view.$("#send-button");
    let called = 0;
    const removed = async () => assert.fail("removed listener must not run");
    const retained = async () => {
      await Promise.resolve();
      called++;
    };
    button.addEventListener("click", removed);
    button.removeEventListener("click", removed);
    button.addEventListener("click", retained);
    button.addEventListener("click", retained);
    button.dispatchEvent(new view.window.Event("click"));
    await view.quiesce();
    assert.equal(called, 1);
  } finally {
    view.restore();
  }
});

test("a body failure handled by the UI is not misreported as an uncaught callback failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => {
      throw new Error("fixture body failed");
    }
  });
  const view = createLiveBrowser("http://fixture.invalid");
  try {
    const button = view.$("#send-button");
    button.addEventListener("click", async () => {
      try {
        await (await fetch("/fixture-body-error")).json();
      } catch (error) {
        document.querySelector("#send-button").dataset.error = error.message;
      }
    });
    button.dispatchEvent(new view.window.Event("click"));
    await view.quiesce();
    assert.equal(button.dataset.error, "fixture body failed");
  } finally {
    view.restore();
    globalThis.fetch = originalFetch;
  }
});
