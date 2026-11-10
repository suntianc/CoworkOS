import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  backgroundMode,
  prepareBackgroundApp,
  enterBackground,
  revealWindow
} = require("../desktop/background-mode.cjs");

function recorder() {
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  return { calls, record };
}

test("background mode is on only for FORMICAND_DESKTOP_BACKGROUND=1", () => {
  assert.equal(backgroundMode({ FORMICAND_DESKTOP_BACKGROUND: "1" }), true);
  assert.equal(backgroundMode({ FORMICAND_DESKTOP_BACKGROUND: "0" }), false);
  assert.equal(backgroundMode({}), false);
});

test("a background app keeps painting, leaves the Dock and never activates", () => {
  const { calls, record } = recorder();
  const app = {
    commandLine: { appendSwitch: record("switch") },
    setActivationPolicy: record("policy"),
    dock: { hide: record("dock.hide") }
  };
  prepareBackgroundApp(app);
  enterBackground(app, "darwin");
  assert.deepEqual(calls, [
    ["switch", "disable-backgrounding-occluded-windows"],
    ["switch", "disable-renderer-backgrounding"],
    ["switch", "disable-background-timer-throttling"],
    ["policy", "accessory"],
    ["dock.hide"]
  ]);
  const other = recorder();
  enterBackground({ setActivationPolicy: other.record("policy") }, "linux");
  assert.deepEqual(other.calls, []);
});

test("revealing a window focuses it only outside background mode", () => {
  const { calls, record } = recorder();
  const window = {
    show: record("show"),
    focus: record("focus"),
    showInactive: record("showInactive"),
    setOpacity: record("opacity"),
    setIgnoreMouseEvents: record("click-through")
  };
  revealWindow(window, false);
  revealWindow(window, true);
  // A background window is invisible and click-through before macOS orders it to the front.
  assert.deepEqual(calls, [["show"], ["focus"], ["opacity", 0], ["click-through", true], ["showInactive"]]);
});
