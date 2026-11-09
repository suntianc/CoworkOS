import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { NATIVE_MATERIAL, windowMaterial } = require("../desktop/window-material.cjs");
const {
  DARK_BACKGROUND,
  LIGHT_BACKGROUND,
  windowBackground,
  followNativeTheme
} = require("../desktop/system-theme.cjs");
const { PRODUCT_NAME } = require("../desktop/product-name.cjs");

test("macOS windows use the native material with a clear painted canvas", () => {
  assert.equal(PRODUCT_NAME, "Formicand");
  assert.deepEqual(windowMaterial("darwin"), {
    material: NATIVE_MATERIAL,
    options: {
      vibrancy: NATIVE_MATERIAL,
      visualEffectState: "active",
      transparent: true,
      backgroundColor: "#00000000"
    }
  });
  assert.equal(windowBackground({ shouldUseDarkColors: true }, "darwin"), "#00000000");
  assert.equal(windowBackground({ shouldUseDarkColors: false }, "darwin"), "#00000000");
});

test("painted platforms keep the themed background and refresh it", () => {
  assert.deepEqual(windowMaterial("linux"), { material: "none", options: {} });
  assert.equal(windowBackground({ shouldUseDarkColors: true }, "linux"), DARK_BACKGROUND);
  assert.equal(windowBackground({ shouldUseDarkColors: false }, "linux"), LIGHT_BACKGROUND);

  const listeners = new Map();
  const colors = [];
  const nativeTheme = {
    shouldUseDarkColors: false,
    on: (event, listener) => listeners.set(event, listener),
    removeListener: (event) => listeners.delete(event)
  };
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: (value) => colors.push(value),
    once: () => {}
  };
  followNativeTheme(window, nativeTheme, { transparent: true });
  assert.equal(listeners.size, 0, "a native material is not repainted");
  assert.deepEqual(colors, []);

  followNativeTheme(window, nativeTheme);
  assert.deepEqual(colors, [LIGHT_BACKGROUND]);
  nativeTheme.shouldUseDarkColors = true;
  listeners.get("updated")();
  assert.deepEqual(colors, [LIGHT_BACKGROUND, DARK_BACKGROUND]);
});
