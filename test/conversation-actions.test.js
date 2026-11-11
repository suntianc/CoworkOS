import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationTaskId, createConversationReadState } from "../web/assets/conversation-actions.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test("unread markers persist and reload without changing another window's markers", () => {
  const storage = memoryStorage();
  const first = createConversationReadState(storage);
  const second = createConversationReadState(storage);
  assert.equal(first.isUnread("task-a"), false);
  assert.equal(first.setUnread("task-a", true), true);
  assert.equal(second.setUnread("task-b", true), true);
  first.reload();
  assert.equal(first.isUnread("task-b"), true);
  assert.equal(first.setUnread("task-a", false), true);
  second.reload();
  assert.equal(second.isUnread("task-a"), false);
  assert.equal(second.isUnread("task-b"), true);
  assert.equal(createConversationReadState(storage).isUnread("task-b"), true);
});

test("blocked or absent storage retains in-memory markers and pending changes survive reload", () => {
  for (const storage of [
    undefined,
    {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      }
    }
  ]) {
    const state = createConversationReadState(storage);
    assert.equal(state.setUnread("task-a", true), false);
    state.reload();
    assert.equal(state.isUnread("task-a"), true);
    assert.equal(state.setUnread("task-a", false), false);
    state.reload();
    assert.equal(state.isUnread("task-a"), false);
  }
  const storage = memoryStorage();
  const write = storage.setItem;
  storage.setItem = () => {
    throw new Error("quota");
  };
  const state = createConversationReadState(storage);
  state.setUnread("task-a", true);
  state.reload();
  assert.equal(state.isUnread("task-a"), true);
  storage.setItem = write;
  assert.equal(state.setUnread("task-b", true), true);
  assert.equal(createConversationReadState(storage).isUnread("task-a"), true);
});

test("invalid stored data and unsafe task identifiers cannot create unread markers", () => {
  for (const value of ["{", "null", "[]", '{"version":2,"unread":["task-a"]}']) {
    const storage = { getItem: () => value, setItem() {} };
    assert.equal(createConversationReadState(storage).isUnread("task-a"), false);
  }
  const state = createConversationReadState({
    getItem: () => JSON.stringify({ version: 1, unread: [null, "../bad", "task-a"] }),
    setItem() {}
  });
  assert.equal(state.isUnread("task-a"), true);
  for (const taskId of ["", "../bad", "task/a", "x\n", null])
    assert.equal(state.setUnread(taskId, true), false);
});

test("conversation links identify the requested task and refuse anything else", () => {
  assert.equal(conversationTaskId("http://127.0.0.1:3881/?view=compact&task=task-a#goals"), "task-a");
  assert.equal(conversationTaskId("https://example.test/?task=task-one_2"), "task-one_2");
  for (const url of [
    "bad",
    "http://localhost/",
    "http://localhost/?task=..%2Fprivate",
    "http://localhost/?task=task%0A",
    "javascript:alert(1)?task=task-a"
  ])
    assert.equal(conversationTaskId(url), null);
});
