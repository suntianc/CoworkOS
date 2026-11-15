import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";
import { createMessageEditController } from "../web/assets/controllers/message-edit.js";
import { reconcileMarkup } from "../web/assets/ui/reconcile.js";
function fixture(api) {
  const input = { value: "", addEventListener() {}, focus() {}, dispatchEvent() {} };
  let attachments = [];
  const values = new Map();
  const session = createComposerSession({
    input,
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    },
    storage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    }
  });
  session.activate("task-a");
  input.value = "original draft";
  const state = { selected: "task-a", detail: { runtime: { active: false } } };
  const errors = [],
    accepted = [];
  const target = {
    messageId: "message",
    versionId: "version",
    runId: "run",
    scopeToken: "a".repeat(64),
    body: "old body\nsecond line",
    attachments: []
  };
  const controller = createMessageEditController({
    composerSession: session,
    input,
    getState: () => state,
    isBusy: () => false,
    api,
    onError: (error) => errors.push(error),
    onChange() {},
    onSubmit: () => controller.submit(),
    onAccepted: (...args) => accepted.push(args)
  });
  return {
    session,
    controller,
    state,
    target,
    input,
    errors,
    accepted,
    cancel: () => controller.cancel()
  };
}
test("failed edit preserves edited body and original draft, cancellation does not send", async () => {
  const calls = [];
  const f = fixture(async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    throw new Error("offline");
  });
  f.controller.begin("task-a", f.target);
  f.session.updateEdit({ text: "changed body" });
  await f.controller.submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].body, "changed body");
  assert.equal(calls[0][1].retryRequestId, undefined);
  assert.equal(f.session.editSnapshot().text, "changed body");
  assert.equal(f.input.value, "original draft");
  assert.equal(f.session.editing.original.text, "original draft");
  assert.match(f.errors[0], /编辑内容和原草稿已保留/);
  f.cancel();
  assert.equal(f.input.value, "original draft");
  assert.equal(calls.length, 1);
});

test("a reused send control submits the current edit after reconciliation", async () => {
  const calls = [];
  const f = fixture(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { runId: "replacement-run" };
  });
  f.controller.begin("task-a", f.target);
  const { document } = parseHTML(
    `<main>${f.controller.markup("task-a", f.target.messageId)}${f.controller.actions("task-a", f.target.messageId)}</main>`
  );
  const root = document.querySelector("main");
  root.querySelector("textarea").setSelectionRange = () => {};
  f.controller.bind(root, "task-a");
  const send = root.querySelector("[data-submit-message-edit]");
  const oldEditId = f.session.editing.editId;
  f.controller.cancel();
  f.controller.begin("task-a", f.target);
  const editId = f.session.editing.editId;
  assert.notEqual(editId, oldEditId);
  reconcileMarkup(
    root,
    f.controller.markup("task-a", f.target.messageId) + f.controller.actions("task-a", f.target.messageId)
  );
  assert.equal(root.querySelector("[data-submit-message-edit]"), send);
  f.session.updateEdit({ text: "replacement after stopping the question" });
  f.controller.bind(root, "task-a");
  assert.equal(send.disabled, false);
  f.state.selected = "another-task";
  send.click();
  assert.equal(calls.length, 0, "a control in another conversation must not dispatch");
  f.state.selected = "task-a";
  send.click();
  await Promise.resolve();
  assert.equal(calls.length, 1, "an enabled send button must dispatch the current edit");
  assert.equal(calls[0].editId, editId);
  assert.equal(calls[0].body, "replacement after stopping the question");
});

test("a reused editor records typing for its current edit identity", () => {
  const f = fixture(async () => ({}));
  f.controller.begin("task-a", f.target);
  const { document, window } = parseHTML(
    `<main>${f.controller.markup("task-a", f.target.messageId)}${f.controller.actions("task-a", f.target.messageId)}</main>`
  );
  const root = document.querySelector("main");
  root.querySelector("textarea").setSelectionRange = () => {};
  f.controller.bind(root, "task-a");
  const editor = root.querySelector("textarea");
  f.controller.cancel();
  f.controller.begin("task-a", f.target);
  reconcileMarkup(
    root,
    f.controller.markup("task-a", f.target.messageId) + f.controller.actions("task-a", f.target.messageId)
  );
  assert.equal(root.querySelector("textarea"), editor);
  f.controller.bind(root, "task-a");
  editor.value = "new edit typing";
  editor.dispatchEvent(new window.Event("input"));
  assert.equal(f.session.editSnapshot().text, "new edit typing");
});
test("a late accepted edit restores its source draft without changing the newly selected conversation", async () => {
  let resolve,
    calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.controller.begin("task-a", f.target);
  f.session.updateEdit({ text: "changed body" });
  const submitted = f.controller.submit();
  await f.controller.submit();
  assert.equal(calls, 1);
  f.session.activate("task-b");
  f.state.selected = "task-b";
  f.input.value = "task-b draft";
  resolve({ runId: "new-run" });
  await submitted;
  assert.equal(f.input.value, "task-b draft");
  assert.equal(f.accepted[0][0], "task-a");
  f.session.activate("task-a");
  assert.equal(f.input.value, "original draft");
});
test("active generation refuses edit and does not queue an edit payload", async () => {
  let calls = 0;
  const f = fixture(() => {
    calls++;
  });
  f.state.detail.runtime.active = true;
  f.controller.begin("task-a", f.target);
  assert.equal(f.session.editing, undefined);
  assert.match(f.errors[0], /先停止/);
  assert.equal(calls, 0);
});

test("a turn parked on a pending question stays editable", async () => {
  const calls = [];
  const f = fixture(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { runId: "replacement-run" };
  });
  // The resident Main keeps the turn in flight while it waits for the answer,
  // and the edit supersedes that question instead of waiting for a timeout.
  f.state.detail.runtime.active = true;
  f.state.detail.humanRequests = [{ requestId: "question", status: "pending" }];
  f.controller.begin("task-a", f.target);
  assert.ok(f.session.editing, "the parked turn can be edited");
  assert.deepEqual(f.errors, []);
  f.session.updateEdit({ text: "replacement of the parked request" });
  await f.controller.submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "replacement of the parked request");
  assert.deepEqual(f.errors, []);
});

test("acceptance does not silently discard text changed while the edit request was pending", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  f.controller.begin("task-a", f.target);
  f.session.updateEdit({ text: "submitted body" });
  const submitted = f.controller.submit();
  f.session.updateEdit({ text: "changed while pending" });
  resolve({ runId: "new-run" });
  await submitted;
  assert.equal(f.session.editSnapshot().text, "changed while pending");
  assert.equal(f.input.value, "original draft");
  assert.equal(f.session.editing.original.text, "original draft");
  assert.match(f.errors[0], /发送期间继续修改/);
});

test("editing and submitting a message leaves new typing in the composer independent", async () => {
  let resolve;
  let submitted;
  const f = fixture((_url, options) => {
    submitted = JSON.parse(options.body);
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.controller.begin("task-a", f.target);
  assert.equal(f.input.value, "original draft");
  f.session.updateEdit({ text: "only send this edited message" });
  f.input.value = "a separate new draft";
  f.session.save();
  const accepted = f.controller.submit();
  f.input.value = "new draft changed during submission";
  f.session.save();
  resolve({ runId: "new-run" });
  await accepted;
  assert.equal(submitted.body, "only send this edited message");
  assert.equal(f.input.value, "new draft changed during submission");
  assert.equal(f.session.editing, undefined);
  assert.deepEqual(f.errors, []);
});
