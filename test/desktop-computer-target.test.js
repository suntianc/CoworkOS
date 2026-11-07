import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { createComputerTargetCoordinator } = require("../desktop/computer-target.cjs");

function fixtures() {
  const calls = [];
  const policies = new Map([
    ["/a", { enabled: true, mode: "control" }],
    ["/b", { enabled: false, mode: "observe" }]
  ]);
  const createStore = (home) => ({
    load: async () => policies.get(home),
    snapshot: () => ({ ...policies.get(home) }),
    save: async (value) => {
      policies.set(home, value);
      return { ...value };
    }
  });
  const shortcuts = [];
  let hold, began;
  const control = (name) => ({
    backendId: name,
    pid: name === "a" ? 101 : 202,
    async computer(input) {
      calls.push([name, input.operation, input.enabled]);
      if (input.operation === "access") return { policy: { enabled: name === "a", mode: "control" } };
      if (input.operation === "status" && hold) {
        began();
        await hold;
      }
      if (input.operation === "status")
        return { available: true, screenRecording: true, accessibility: true, postEventAccess: true };
      return {};
    },
    async pauseRetired() {
      calls.push([name, "retired-pause"]);
    }
  });
  const coordinator = createComputerTargetCoordinator({
    createStore,
    registerTakeover: (x) => {
      shortcuts.push(x);
      return null;
    }
  });
  return {
    coordinator,
    control,
    calls,
    policies,
    shortcuts,
    holdStatus(wait, started) {
      hold = wait;
      began = started;
    }
  };
}

test("target switch rejects while an operation is in flight and does not move it", async () => {
  const f = fixtures(),
    a = f.control("a"),
    b = f.control("b");
  await f.coordinator.beginSwitch();
  assert.deepEqual(await f.coordinator.activate("/a", a), { ok: true });
  f.coordinator.endSwitch();
  let release, started;
  const wait = new Promise((r) => {
    release = r;
  });
  const entered = new Promise((r) => {
    started = r;
  });
  f.holdStatus(wait, started);
  const request = f.coordinator.request({ operation: "status" });
  await entered;
  await assert.rejects(f.coordinator.beginSwitch(), /正在进行/);
  assert.equal(f.coordinator.status().backendId, "a");
  release();
  await request;
  await f.coordinator.beginSwitch();
  assert.deepEqual(await f.coordinator.activate("/b", b), { ok: true });
  f.coordinator.endSwitch();
  assert.equal(f.coordinator.status().backendId, "b");
  assert.ok(f.calls.some(([target, operation]) => target === "a" && operation === "release-sessions"));
  assert.ok(f.calls.some(([target, operation]) => target === "b" && operation === "access"));
});

test("failed switch preserves A; committed B restoration failure stays on B and can retry", async () => {
  const f = fixtures(),
    a = f.control("a"),
    b = f.control("b");
  await f.coordinator.beginSwitch();
  await f.coordinator.activate("/a", a);
  f.coordinator.endSwitch();
  await f.coordinator.beginSwitch();
  f.coordinator.endSwitch();
  assert.equal(f.coordinator.status().backendId, "a");
  assert.equal(f.shortcuts.at(-1), true);
  let fail = true;
  const computer = b.computer;
  b.computer = async (input) => {
    if (fail && input.operation === "access") throw new Error("B unavailable");
    return computer(input);
  };
  await f.coordinator.beginSwitch();
  const result = await f.coordinator.activate("/b", b);
  assert.equal(result.ok, false);
  assert.equal(f.coordinator.status().backendId, "b");
  f.coordinator.endSwitch();
  fail = false;
  assert.equal((await f.coordinator.request({ operation: "status" })).available, true);
  assert.equal(f.coordinator.status().ready, true);
});

test("takeover during switch pauses the captured old host and navigation never releases B", async () => {
  const f = fixtures(),
    a = f.control("a"),
    b = f.control("b");
  await f.coordinator.beginSwitch();
  await f.coordinator.activate("/a", a);
  f.coordinator.endSwitch();
  await f.coordinator.beginSwitch();
  await f.coordinator.activate("/b", b);
  const before = f.calls.length;
  await f.coordinator.releaseForNavigation();
  await f.coordinator.pauseForTakeover();
  assert.deepEqual(f.calls.slice(before), [["a", "retired-pause"]]);
  f.coordinator.endSwitch();
  await f.coordinator.releaseForNavigation();
  assert.deepEqual(f.calls.at(-1), ["b", "release-sessions", undefined]);
});

test("a confirmed stopped target cannot be restored when restart fails", async () => {
  const f = fixtures(),
    a = f.control("a");
  await f.coordinator.beginSwitch();
  await f.coordinator.activate("/a", a);
  f.coordinator.endSwitch();
  await f.coordinator.beginSwitch();
  f.coordinator.invalidateStopped("a", 101);
  f.coordinator.endSwitch();
  assert.equal(f.coordinator.status().ready, false);
  assert.equal(f.shortcuts.at(-1), false);
  await assert.rejects(f.coordinator.request({ operation: "status" }), /不可用/);
});
