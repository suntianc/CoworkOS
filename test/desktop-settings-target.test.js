import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("settings target lease rejects identity changes and releases after failure and restart", async () => {
  const { createSettingsTargetGuard } = require("../desktop/settings-target.cjs");
  const a = { backendId: "backend_A", url: "http://127.0.0.1:39001", pid: 101, startedAt: "start-A" };
  let owner = a;
  let selected = a;
  let live = a;
  const target = createSettingsTargetGuard({
    getOwner: () => owner,
    getSelected: () => selected,
    verifySelected: async () => live
  });
  assert.equal(await target.settings(async () => "A status"), "A status");
  live = { ...a, pid: 303 };
  await assert.rejects(
    target.settings(async () => "wrong"),
    /身份/
  );
  live = a;
  await assert.rejects(
    target.select(async () => {
      throw new Error("cancelled");
    }),
    /cancelled/
  );
  assert.equal(await target.settings(async () => "A again"), "A again");
  let releaseRestart;
  const restart = new Promise((done) => {
    releaseRestart = done;
  });
  assert.equal(
    await target.settings(async ({ retainUntil }) => {
      retainUntil(restart);
      return "saved";
    }),
    "saved"
  );
  await assert.rejects(
    target.select(async () => {}),
    /后端|设置/
  );
  releaseRestart();
  await restart;
  assert.equal(await target.select(async () => "selected"), "selected");
  const b = { ...a, backendId: "backend_B", url: "http://127.0.0.1:39002", pid: 202, startedAt: "start-B" };
  selected = b;
  live = b;
  await assert.rejects(
    target.settings(async () => "wrong"),
    /backend_B.*backend_A/
  );
  owner = b;
  assert.equal(await target.settings(async () => "B status"), "B status");
});

test("a delayed settings read cannot return after the selected live instance changes", async () => {
  const { createSettingsTargetGuard } = require("../desktop/settings-target.cjs");
  const a = { backendId: "backend_A", url: "http://127.0.0.1:39001", pid: 101, startedAt: "start-A" };
  let live = a;
  const target = createSettingsTargetGuard({
    getOwner: () => a,
    getSelected: () => a,
    verifySelected: async () => live
  });
  let release;
  let reached;
  const started = new Promise((done) => {
    reached = done;
  });
  const waiting = new Promise((done) => {
    release = done;
  });
  const read = target.settings(async () => {
    reached();
    await waiting;
    return "stale A settings";
  });
  await started;
  await assert.rejects(
    target.select(async () => {}),
    /后端|设置/
  );
  live = { ...a, pid: 202, startedAt: "new-start" };
  release();
  await assert.rejects(read, /身份/);
  assert.equal(await target.select(async () => "unlocked"), "unlocked");
});
