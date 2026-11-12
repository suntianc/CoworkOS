import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectionController } from "../web/assets/controllers/connection-controller.js";

function fixture(t) {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget();
  const document = (globalThis.document = new EventTarget());
  const state = { selected: null, tasks: [] };
  const detailReads = [];
  const controller = createConnectionController({
    state,
    loadDetail: (id) => detailReads.push(id)
  });
  t.after(() => {
    controller.dispose();
    globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  });
  return { controller, state, detailReads, document };
}

test("only the selected open SSE connection slows fallback polling, and disconnect requests recovery", (t) => {
  const f = fixture(t);
  const streams = [];
  window.EventSource = class {
    constructor() {
      streams.push(this);
    }
    close() {}
  };
  const previousSource = globalThis.EventSource;
  globalThis.EventSource = window.EventSource;
  t.after(() => {
    if (previousSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousSource;
  });
  f.state.selected = "a";
  f.state.tasks = ["a", "b"].map((taskId) => ({ taskId, status: "running", activeRunId: taskId }));
  f.controller.connect("a");
  assert.equal(f.controller.isStreaming("a"), false);
  streams[0].onopen();
  assert.equal(f.controller.isStreaming("a"), true);
  f.state.selected = "b";
  f.controller.connect("b");
  const latest = streams.at(-1);
  latest.onopen();
  streams[0].onerror();
  assert.equal(f.controller.isStreaming("b"), true, "an old stream cannot change the new connection");
  assert.deepEqual(f.detailReads, []);
  latest.onerror();
  assert.equal(f.controller.isStreaming("b"), false);
  assert.deepEqual(f.detailReads, ["b"]);
  f.controller.connect("b");
  streams.at(-1).onopen();
  f.controller.close();
  assert.equal(f.controller.isStreaming("b"), false);
});
