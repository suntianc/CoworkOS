import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberedTaskMap } from "../web/assets/remembered-choices.js";

const memoryStorage = () => {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
};

test("a conversation's picked level outlives the page, and the default is nothing to remember", () => {
  const storage = memoryStorage();
  const levels = rememberedTaskMap(() => storage, "levels");
  levels.set("task-a", "high").set("task-b", "low");
  levels.set("task-b", null);
  // A restart reads the same storage afresh.
  const restarted = rememberedTaskMap(() => storage, "levels");
  assert.equal(restarted.get("task-a"), "high");
  assert.equal(restarted.has("task-b"), false);
  assert.equal(restarted.get("task-b") ?? null, null);
  restarted.clear();
  assert.equal(rememberedTaskMap(() => storage, "levels").get("task-a"), undefined);
});

test("blocked or damaged storage leaves the choices working for this page", () => {
  const blocked = rememberedTaskMap(() => {
    throw new Error("SecurityError");
  }, "levels");
  blocked.set("task-a", "max");
  assert.equal(blocked.get("task-a"), "max");
  const storage = memoryStorage();
  storage.setItem("levels", "{not json");
  assert.equal(rememberedTaskMap(() => storage, "levels").get("task-a"), undefined);
});
