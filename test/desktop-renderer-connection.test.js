import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { connectRenderer } = createRequire(import.meta.url)("../desktop/renderer-connection.cjs");
const backend = { url: "http://127.0.0.1:12345" };

test("renderer navigates the live window to the selected backend", async () => {
  const loaded = [];
  await connectRenderer(backend, () => ({
    isDestroyed: () => false,
    loadURL: async (url) => loaded.push(url)
  }));
  assert.deepEqual(loaded, [backend.url]);
});

test("a closed renderer is not navigated and a failed navigation is reported", async () => {
  await connectRenderer(backend, () => undefined);
  await connectRenderer(backend, () => ({ isDestroyed: () => true, loadURL: () => assert.fail("closed") }));
  await assert.rejects(
    connectRenderer(backend, () => ({
      isDestroyed: () => false,
      loadURL: async () => {
        throw new Error("navigation failed");
      }
    })),
    /navigation failed/
  );
});
