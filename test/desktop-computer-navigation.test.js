import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { createComputerNavigationGuard } = require("../desktop/computer-navigation.cjs");
const { createComputerTargetCoordinator } = require("../desktop/computer-target.cjs");

const event = (url) => ({ isMainFrame: true, isSameDocument: false, url });
function fixture() {
  const calls = [],
    views = [];
  const guard = createComputerNavigationGuard({
    release: () => calls.push("release"),
    closeViewers: () => views.push("closed")
  });
  return { guard, calls, views };
}
test("controlled navigation skips only the matching first main document", async () => {
  const { guard, calls, views } = fixture();
  await guard.navigate("http://127.0.0.1:4500", async () => {
    guard.started(event("http://127.0.0.1:4500/?task=1"), "http://127.0.0.1:4400/");
    assert.deepEqual(calls, []);
    guard.started(event("http://127.0.0.1:4500/"), "http://127.0.0.1:4500/");
  });
  assert.deepEqual(calls, ["release"]);
  assert.equal(views.length, 2);
});
test("failed or mismatched controlled navigation cannot suppress a later release", async () => {
  const { guard, calls } = fixture();
  await assert.rejects(
    guard.navigate("http://127.0.0.1:4500", async () => {
      throw new Error("load failed");
    }),
    /load failed/
  );
  guard.started(event("http://127.0.0.1:4500/"), "http://127.0.0.1:4400/");
  await guard.navigate("http://127.0.0.1:4500", async () => {
    guard.started(event("http://127.0.0.1:4500/api/artifact"), "http://127.0.0.1:4400/");
    guard.started(event("http://127.0.0.1:4500/"), "http://127.0.0.1:4500/");
  });
  await guard.navigate("http://127.0.0.1:4500", async () => {
    guard.started(event("http://127.0.0.1:4600/"), "http://127.0.0.1:4400/");
  });
  assert.deepEqual(calls, ["release", "release", "release", "release"]);
});
test("controlled switch keeps B sessions and ordinary navigation releases B", async () => {
  const calls = [];
  const backend = {
    backendId: "b",
    computer: async (input) => {
      calls.push(input.operation);
      return {};
    }
  };
  const store = { load: async () => {}, snapshot: () => ({ enabled: false, mode: "observe" }) };
  const targets = createComputerTargetCoordinator({ createStore: () => store, registerTakeover: () => null });
  await targets.beginSwitch();
  await targets.activate("/b", backend);
  targets.endSwitch();
  const guard = createComputerNavigationGuard({
    release: () => {
      void targets.releaseForNavigation();
    },
    closeViewers: () => {}
  });
  const before = calls.length;
  await guard.navigate("http://127.0.0.1:4500", async () =>
    guard.started(event("http://127.0.0.1:4500/"), "http://127.0.0.1:4400/")
  );
  assert.deepEqual(calls.slice(before), []);
  guard.started(event("http://127.0.0.1:4500/"), "http://127.0.0.1:4500/");
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls.slice(before), ["release-sessions"]);
});
